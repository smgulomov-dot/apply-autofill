// ==UserScript==
// @name         Apartment-bot application autofill
// @namespace    apartment-bot
// @version      2.0
// @description  Fills a portal's contact form from a link sent by the apartment bot. Works on Immowelt, ImmoScout24, Kleinanzeigen and WG-Gesucht. Never submits on its own.
// @match        https://www.immowelt.de/expose/*
// @match        https://www.immowelt.de/projekte/expose/*
// @match        https://www.immobilienscout24.de/expose/*
// @match        https://www.kleinanzeigen.de/s-anzeige/*
// @match        https://www.wg-gesucht.de/nachricht-senden/*
// @match        https://www.wg-gesucht.de/*.html
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * How this works
 * --------------
 * The bot sends you a link whose URL *fragment* carries your application data:
 *
 *     https://www.<portal>/.../<id>#apply=<base64url json>
 *
 * Browsers never transmit the fragment to the server, so your name, email and
 * phone stay on your machine until you press the portal's own send button.
 *
 * Why a userscript and not a bot request: every portal's contact form either is
 * React-controlled with no form action, sits behind a bot wall (DataDome /
 * Akamai) that blocks automated requests, or requires your own logged-in
 * session. Your browser is a normal session, so filling the form here works
 * where an automated request cannot.
 *
 * This script deliberately DOES NOT submit. It opens the contact form if it is
 * behind a button, fills the fields it recognises, highlights them, and leaves
 * the send button to you.
 *
 * Field detection is heuristic (type / autocomplete / name / placeholder) so it
 * works across portals and survives their frequent redesigns. Missing fields
 * are simply skipped.
 */

(function () {
    'use strict';

    const PREFIX = '#apply=';
    if (!location.hash.startsWith(PREFIX)) return;

    let data;
    try {
        const json = decodeURIComponent(
            escape(atob(location.hash.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'))),
        );
        data = JSON.parse(json);
    } catch (err) {
        console.warn('[apply-autofill] could not read payload:', err);
        return;
    }

    /**
     * React tracks the previous value on the DOM node, so a plain `el.value = x`
     * is ignored on the next render. Going through the native prototype setter
     * and dispatching input/change is what makes React pick the change up.
     */
    function setValue(el, value) {
        if (!el || value == null || value === '') return false;
        const proto =
            el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.style.outline = '2px solid #2e7d32';
        return true;
    }

    const isVisible = (el) => {
        if (!el || el.disabled || el.readOnly) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none';
    };

    const attrs = (el) =>
        `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
    const autocomplete = (el) => (el.getAttribute('autocomplete') || '').toLowerCase();

    /** All fillable, currently-empty, visible controls. */
    function controls(tag) {
        const sel = tag || 'input, textarea';
        return [...document.querySelectorAll(sel)].filter(
            (el) => isVisible(el) && !el.value && !/^(hidden|checkbox|radio|submit|button|file)$/.test(el.type || ''),
        );
    }

    const first = (preds) => {
        for (const pred of preds) {
            const el = controls().find(pred);
            if (el) return el;
        }
        return null;
    };

    // Heuristic finders, strongest signal first.
    const FINDERS = {
        message: () => {
            const ta = controls('textarea');
            return ta.find((el) => /nachricht|message|anfrage|mitteilung|anschreiben|text/.test(attrs(el))) || ta[0] || null;
        },
        email: () => first([(el) => el.type === 'email', (el) => autocomplete(el) === 'email', (el) => /e-?mail/.test(attrs(el))]),
        phone: () => first([(el) => el.type === 'tel', (el) => autocomplete(el).includes('tel'), (el) => /phone|telefon|handy|mobil|\btel\b/.test(attrs(el))]),
        firstName: () => first([(el) => autocomplete(el) === 'given-name', (el) => /vorname|first.?name|firstname|given.?name/.test(attrs(el))]),
        lastName: () => first([(el) => autocomplete(el) === 'family-name', (el) => /nachname|last.?name|lastname|surname|family.?name/.test(attrs(el))]),
        fullName: () => first([(el) => autocomplete(el) === 'name', (el) => /voller name|full.?name|ihr name|\bname\b/.test(attrs(el))]),
        street: () => first([(el) => autocomplete(el).includes('address-line1'), (el) => /stra(ß|ss)e|street|anschrift|adresse|address/.test(attrs(el))]),
        zipCode: () => first([(el) => autocomplete(el) === 'postal-code', (el) => /plz|postleitzahl|\bzip\b|postal/.test(attrs(el))]),
        city: () => first([(el) => autocomplete(el).includes('address-level2'), (el) => /\bstadt\b|\bort\b|\bcity\b/.test(attrs(el))]),
    };

    function fill() {
        let filled = 0;
        let firstFilled = null;
        const put = (el, value) => {
            if (setValue(el, value)) {
                filled++;
                if (!firstFilled) firstFilled = el;
            }
        };

        put(FINDERS.message(), data.message);
        put(FINDERS.email(), data.email);
        put(FINDERS.phone(), data.phone);

        const fn = FINDERS.firstName();
        const ln = FINDERS.lastName();
        if (fn || ln) {
            put(fn, data.firstName);
            put(ln, data.lastName);
        } else {
            const full = [data.firstName, data.lastName].filter(Boolean).join(' ');
            put(FINDERS.fullName(), full);
        }

        put(FINDERS.street(), data.street);
        put(FINDERS.zipCode(), data.zipCode);
        put(FINDERS.city(), data.city);

        if (firstFilled) firstFilled.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return filled;
    }

    /** When the form is behind a button, click the most likely opener. */
    function revealForm() {
        if (document.querySelector('textarea')) return;
        const opener = [...document.querySelectorAll('button, a, [role="button"]')].find((b) =>
            /nachricht schreiben|nachricht senden|kontakt aufnehmen|kontaktieren|anfrage senden|anbieter kontaktieren|senden sie eine nachricht|contact|send message/i.test(
                (b.textContent || '').trim(),
            ),
        );
        if (opener) opener.click();
    }

    function banner(text, colour) {
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = [
            'position:fixed', 'z-index:2147483647', 'left:50%', 'top:16px',
            'transform:translateX(-50%)', 'padding:10px 16px', 'border-radius:8px',
            'font:600 14px/1.3 system-ui,sans-serif', 'color:#fff', 'max-width:90vw',
            `background:${colour}`, 'box-shadow:0 2px 12px rgba(0,0,0,.25)',
        ].join(';');
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 9000);
    }

    // Poll: forms mount late and some hide behind a button. Give it ~25 s.
    let tries = 0;
    const timer = setInterval(() => {
        tries++;
        revealForm();
        if (document.querySelector('textarea')) {
            clearInterval(timer);
            const n = fill();
            if (n > 0) banner(`✅ ${n} Felder ausgefüllt — bitte prüfen und selbst absenden.`, '#2e7d32');
            else banner('⚠️ Formular gefunden, aber keine Felder befüllt.', '#b26500');
        } else if (tries > 50) {
            clearInterval(timer);
            banner('⚠️ Kontaktformular nicht gefunden — bitte manuell öffnen.', '#b26500');
        }
    }, 500);
})();
