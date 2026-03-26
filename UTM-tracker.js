/*
The problem:

1) UTM parameters only exist in the URL of the first page the user lands on.

2) If the user clicks around before submitting a form, that data is lost, unless we store it

3) Can’t store data without consent, because of CookieYes, would be very bad

4) The form (Marketo) is embedded and not native to WordPress, so it must be accessed via JS

5) Marketo sends leads to Salesforce, so we must inject data into fields Marketo will pass along.


UTM parameters to use for testing: 

?utm_source=test-source&utm_medium=test-medium&utm_campaign=test-campaign&utm_content=test-content

*/


// This script should be added to the header of the site, and will run on every page. This script is what allows the file to run within the website and we DO NOT need to enqueue the file within functions.php
// we may not need the 'type' attribute, this can cause MIME Type issues
<script
  data-cookieyes="cookieyes-analytics"
  id="UTM-tracker"
  type="text/javascript"
  src="/wp-content/themes/Divi-Child-Theme/js/UTM-tracker.js">
</script>



(function () {
  // console.log('Cookie script loaded')
  // config & cookie variables
  const COOKIE_HOURS = 24; // how long each of the 4 cookies lasts
  const COOKIE_PATH = '/';
  const COOKIE_DOMAIN = ''; // add domain if planning on using for multiple domains or cross-subdomain

  const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
  const FIELD_NAMES = {
    utm_source: ['utm_source', 'mkto_UTM_Source__c'],
    utm_medium: ['utm_medium', 'mkto_UTM_Medium__c'],
    utm_campaign: ['utm_campaign', 'mkto_UTM_Campaign__c'],
    utm_content: ['utm_content', 'mkto_UTM_Content__c']
  };

  // map all the UTM keys -> cookie names
  const COOKIE_NAME_MAP = {
    utm_source: 'iiq_utm_source',
    utm_medium: 'iiq_utm_medium',
    utm_campaign: 'iiq_utm_campaign',
    utm_content: 'iiq_utm_content'
  };

  // Cookie storage
  const cookieStorage = {
    setItem: function (name, value, hours = COOKIE_HOURS) {
      try {
        const cookieDate = new Date();
        cookieDate.setTime(cookieDate.getTime() + (hours * 60 * 60 * 1000));
        const expires = 'expires=' + cookieDate.toUTCString();
        const secure = (location.protocol === 'https:') ? ' Secure;' : '';
        const domain = COOKIE_DOMAIN ? (' domain=' + COOKIE_DOMAIN + ';') : '';
        document.cookie =
          encodeURIComponent(name) + '=' + encodeURIComponent(value) + '; ' +
          expires + '; path=' + COOKIE_PATH + ';' + domain + ' SameSite=Lax;' + secure;
      } catch (err) { console.warn('Warning: Failed to setItem - [UTM-Cookie]', name, err); }
    },
    getItem: function (name) {
      try {
        const target = encodeURIComponent(name) + '=';
        const cookieList = document.cookie ? document.cookie.split(';') : [];
        for (let cookieItems of cookieList) {
          cookieItems = cookieItems.trim();
          if (cookieItems.indexOf(target) === 0) return decodeURIComponent(cookieItems.substring(target.length));
        }
        return null;
      } catch (err) { console.warn('Warning: Failed to getItem - [UTM-Cookie]', name, err); return null; }
    },
    removeItem: function (name) {
      try {
        const past = 'Thu, 01 Jan 1970 00:00:00 GMT'; // any date in the past should work
        const secure = (location.protocol === 'https:') ? ' Secure;' : '';
        const domain = COOKIE_DOMAIN ? (' domain=' + COOKIE_DOMAIN + ';') : '';
        document.cookie =
          encodeURIComponent(name) + '=; expires=' + past + '; path=' + COOKIE_PATH + ';' + domain + ' SameSite=Lax;' + secure;
      } catch (err) { console.warn('Warning: Failed to removeItem - [UTM-cookie]', name, err); }
    }
  };
  
  // URL helpers
  function hasUtmsInURL() {
    const qs = new URLSearchParams(window.location.search);
    return UTM_KEYS.some(utmKey => qs.has(utmKey));
  }
  function getUtmsFromURL() {
    const qs = new URLSearchParams(window.location.search);
    const out = {};
    UTM_KEYS.forEach(utmKey => {
      const val = qs.get(utmKey);
      if (val) out[utmKey] = val.trim();
    });
    return out;
  }

  // cookie helpers
  // 'k' means 'key', 'v' means 'value'
  function saveUtms(utms) {
    try {
      Object.entries(utms).forEach(([k, v]) => {
        cookieStorage.setItem(COOKIE_NAME_MAP[k] || k, v, COOKIE_HOURS);
      });
    } catch (err) { console.warn('Warning: Failed to save UTMs to cookie', err); }
  }
  function loadUtms() {
    const out = {};
    UTM_KEYS.forEach(k => {
      const v = cookieStorage.getItem(COOKIE_NAME_MAP[k] || k);
      if (v) out[k] = v; // keep keys plain: utm_source, etc
    });
    return out;
  }

  function ensureUtmCookiesExist() {
    UTM_KEYS.forEach(k => {
      const name = COOKIE_NAME_MAP[k] || k;
      if (cookieStorage.getItem(name) === null) {
        cookieStorage.setItem(name, '', COOKIE_HOURS);
      }
    });
  }

  // Marketo fallback (cookies -> hidden fields) should only run when URL has NO UTMs
  function applyCookieUtmsToForm(form) {
    if (hasUtmsInURL()) return;// if URL has UTMs, let marketo handle it - core functionality of marketo
    try {
      const stored = loadUtms();
      if (!Object.keys(stored).length) return;

      const formElem = form.getFormElem()[0];
      const currentVals = form.getValues();
      const updates = {};

      UTM_KEYS.forEach(utmKey => {
        const candidates = FIELD_NAMES[utmKey] || [utmKey];
        for (const fieldName of candidates) {
          if (fieldName in currentVals) {
            const input = formElem.elements[fieldName];
            const existing = (currentVals[fieldName] || (input && input.value) || '').trim();
            const fallback = (stored[utmKey] || '').trim();
            if (!existing && fallback) {
              updates[fieldName] = fallback;
            }
            break;
          }
        }
      });

      if (Object.keys(updates).length) form.setValues(updates);
    } catch (err) { console.warn('[UTM Cookie] Failed to apply UTM data to form:', err); }
  }

  // /wait for Marketo, then apply cookie fallback if needed. should run AFTER marketo has loaded
  (function waitForMkto(maxMs = 10000, step = 200) {
    const ready = !!(window.MktoForms2 && typeof MktoForms2.whenReady === 'function');
    if (ready) {
      MktoForms2.whenReady(function (form) {
        // debug what fields Marketo exposes
        // try { console.log('[Mkto] keys:', Object.keys(form.getValues())); } catch (e) {}
        applyCookieUtmsToForm(form);
      });
      return;
    }
    if (maxMs <= 0) return;
    setTimeout(() => waitForMkto(maxMs - step, step), step);
  })();

  // Init on any page WITH UTMs, store them for 48hours
  (function init() {
    ensureUtmCookiesExist();
    const urlUtms = getUtmsFromURL();
    if (Object.keys(urlUtms).length) {
      saveUtms(urlUtms);// write/refresh cookies; Marketo will use URL on this page
    }
  })();

  // helper for testing
  window.__resetUTMCookies = function () {
    UTM_KEYS.forEach(k => cookieStorage.removeItem(COOKIE_NAME_MAP[k] || k));
    console.log('[UTM Cookie] Cleared all iiq_utm cookies.');
  };
})();