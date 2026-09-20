/*
 * TypeSafe ticket source for the Evolve Data Sorting Simulation.
 *
 * The simulation normally hands each ticket a random category index, so the
 * agents are really only learning to match a colour. This module replaces that
 * with real natural-language ticket text whose category is decided by TypeSafe's
 * System One model (Jev) via a `choice` judgment. The selected label becomes the
 * ground truth the agents are graded against, so the population is learning to
 * route tickets that were classified the way a real triage desk would classify
 * them.
 *
 * API contract (verified against @typesafe-ai/sdk 0.6.0):
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <key>
 *   body: { model, state, questions: { <name>: { type: "choice", instructions, criteria } } }
 *   -> { model, usage, answers: { <name>: { type, choice, confidence, probabilities } } }
 *
 * SECURITY: this runs the key in the browser, so anyone who can open the page
 * can read it. That is acceptable only for a local copy. Do not paste a key into
 * a publicly hosted deployment of this file. See README.md.
 */
(function (global) {
  'use strict';

  var BASE_URL = 'https://api.typesafe.ai';
  var ENDPOINT = '/v1/systemone';
  var DEFAULT_MODEL = 'jev-latest';

  var KEY_STORAGE = 'foodsim.typesafe.apiKey';
  var CACHE_STORAGE = 'foodsim.typesafe.labelCache.v1';

  // Tickets per request. Each ticket is an independent question over one shared
  // state object, so they are answered in parallel in a single round trip.
  var BATCH_SIZE = 8;
  // Keep this many labelled tickets ready so the simulation never blocks.
  var POOL_TARGET = 24;

  var MAX_RETRIES = 2;
  var BACKOFF_INITIAL_MS = 500;
  var BACKOFF_MAX_MS = 5000;
  var TIMEOUT_MS = 20000;

  /*
   * The judgment. Criteria are written as concrete situations rather than bare
   * label names so the distinction carries its own meaning, and the ticket text
   * is referenced by its state path.
   */
  var INSTRUCTIONS_PREFIX = 'Classify the support ticket in ';
  var CRITERIA = {
    incident: 'Something that was working is broken or degraded right now and a ' +
      'user is blocked or impaired. The ticket reports a failure, an outage, an ' +
      'error message, or unexpected behaviour that needs service restored.',
    request: 'A user is asking for something to be provided, changed, or granted ' +
      'as routine service: access, an account, a licence, hardware, a password ' +
      'reset, an install, or a standard configuration change. Nothing is broken.',
    problem: 'The ticket is about the underlying cause of failures rather than a ' +
      'single user being blocked: a recurring or repeating fault, a pattern ' +
      'across many incidents, or an investigation into why something keeps ' +
      'happening. Often raised by staff rather than an affected end user.'
  };

  /*
   * Unlabelled ticket text. There is deliberately no category stored here: the
   * whole point is that Jev decides, and some of these are genuinely borderline
   * so the confidence spread is visible in the UI.
   */
  var CORPUS = [
    'Outlook has been stuck on "Trying to connect" since this morning. I cannot see any new mail and I have a client deadline at 14:00.',
    'Could I get access to the shared Finance drive? My manager Anna has approved it, see the attached mail thread.',
    'This is the fourth time this month that the printer on floor 3 drops off the network after a reboot. Someone should look at why it keeps happening rather than just reconnecting it again.',
    'Need a new laptop for a contractor starting on Monday. Standard developer image is fine.',
    'The payment service returns 502 for roughly one in ten checkout attempts. Started about 40 minutes ago.',
    'Please reset my password, I am locked out after too many attempts.',
    'VPN disconnects every 15-20 minutes for everyone in the Malmö office. Individually we have been raising tickets for weeks, I think there is a common cause.',
    'Requesting a Photoshop licence for the marketing team, two seats.',
    'My screen is completely black after the update last night. The machine powers on but nothing appears.',
    'Can you install the new HR reporting tool on my workstation?',
    'Database replication lag has been climbing steadily and alerting fired twice overnight. Nothing is down yet but we should find the root cause before it is.',
    'The coffee machine badge reader does not recognise my card any more.',
    'All of Sales cannot log in to the CRM. Error says "authentication provider unavailable".',
    'I would like a second monitor for my desk, please.',
    'Website images load very slowly from the Gothenburg office but fine from home. Been like that on and off for a while.',
    'Someone deleted the Q3 folder from SharePoint. Can it be restored?',
    'Laptop fan runs constantly and the machine is extremely hot to touch, it shut itself down twice today.',
    'New starter in Logistics needs accounts for email, Slack and the warehouse system. Start date 1 October.',
    'We keep seeing intermittent "connection reset" errors between the API gateway and the order service. Different users, different times, same signature.',
    'Please grant me admin rights on my own machine so I can install development tools.',
    'The invoice export produced a file with no rows this morning. It worked yesterday.',
    'Can you change my display name in the directory? It still shows my previous surname.',
    'Teams call quality is terrible for the whole department, choppy audio and frozen video since the network maintenance on Tuesday.',
    'Requesting an increase to my mailbox quota, I am at 98%.',
    'Backup job for the file server has failed silently three nights running. No alert was raised, which is itself concerning.',
    'My keyboard stopped working after I spilled water on it.',
    'Need access to the staging environment for the new integration work.',
    'Users across several teams report that the search function returns no results for terms that definitely exist. Seems to have started after the index rebuild.',
    'Could someone set up a distribution list for the project steering group?',
    'The building door system is offline and staff cannot enter through the north entrance.',
    'I get "certificate expired" when opening the internal wiki. Others see it too.',
    'Please remove the leaver access for Johan Berg, last day was Friday.',
    'Mobile app crashes on launch for Android 14 users. We have had a dozen reports, and the crash signature is the same each time.',
    'Requesting a docking station for the new laptop model.',
    'Salesforce sync stopped overnight, no records have come through since 02:00.',
    'Can I have the SPSS software installed for the analytics course?',
    'Every Monday morning the batch job queue backs up for about two hours. It clears on its own but it has been the same pattern since spring.',
    'My headset microphone is not detected in any application.',
    'Need a guest wifi code for visitors on Thursday, roughly 20 people.',
    'The reporting dashboard shows last week numbers even after refresh. Finance are using it for a board pack today.',
    'Please move my desk phone extension to the new seat, 4th floor east.',
    'Two different customers have reported the same duplicate-charge behaviour this week. I suspect the retry logic, can someone investigate properly?',
    'Cannot open any PDF attachments, Acrobat throws an error on every file.',
    'Requesting an upgrade to the standard storage allocation for our team share.',
    'The scheduled nightly data import has silently skipped records on and off for months. We patch the data each time but nobody has found why.',
    'Server room temperature alarm is showing amber, on-site staff should check the AC unit.',
    'Could you enable multi-factor authentication for my account?',
    'The login page loads but the submit button does nothing for Safari users specifically.'
  ];

  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  function safeGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }

  function safeSet(key, value) {
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function safeRemove(key) {
    try { global.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function shuffled(list) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  function TicketLabeler(options) {
    options = options || {};
    this.labels = options.labels || Object.keys(CRITERIA);
    this.model = options.model || DEFAULT_MODEL;
    this.baseURL = options.baseURL || BASE_URL;
    this.corpus = options.corpus || CORPUS;

    this.apiKey = safeGet(KEY_STORAGE) || '';
    this.enabled = false;
    this.inFlight = false;
    this.stopped = false;

    // Labelled tickets waiting to be handed to the simulation.
    this.pool = [];
    // Texts not yet sent, refilled from the corpus when exhausted.
    this.queue = shuffled(this.corpus);
    // text hash -> { label, confidence, probabilities }
    this.cache = this.loadCache();

    this.status = 'idle';
    this.lastError = null;
    this.stats = { requests: 0, labelled: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
    this.listeners = [];
  }

  TicketLabeler.prototype.cacheKey = function (text) {
    // Scope the cache to the question, so editing criteria or switching model
    // does not serve stale judgments.
    return hash(this.model + '|' + this.labels.join(',') + '|' + text);
  };

  TicketLabeler.prototype.loadCache = function () {
    var raw = safeGet(CACHE_STORAGE);
    if (!raw) return {};
    try {
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      return {};
    }
  };

  TicketLabeler.prototype.saveCache = function () {
    if (!safeSet(CACHE_STORAGE, JSON.stringify(this.cache))) {
      // Quota exceeded or storage blocked: drop the cache rather than wedge.
      this.cache = {};
      safeRemove(CACHE_STORAGE);
    }
  };

  TicketLabeler.prototype.onChange = function (fn) {
    this.listeners.push(fn);
  };

  TicketLabeler.prototype.emit = function () {
    for (var i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](this); } catch (e) { /* a bad listener must not stall labelling */ }
    }
  };

  TicketLabeler.prototype.setStatus = function (status, error) {
    this.status = status;
    this.lastError = error || null;
    this.emit();
  };

  TicketLabeler.prototype.setApiKey = function (key) {
    this.apiKey = (key || '').trim();
    if (this.apiKey) safeSet(KEY_STORAGE, this.apiKey);
    else safeRemove(KEY_STORAGE);
    this.emit();
  };

  TicketLabeler.prototype.hasApiKey = function () {
    return !!this.apiKey;
  };

  TicketLabeler.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    this.stopped = false;
    if (this.enabled) {
      this.setStatus(this.hasApiKey() ? 'idle' : 'needs-key');
      this.refill();
    } else {
      this.setStatus('off');
    }
  };

  TicketLabeler.prototype.clearCache = function () {
    this.cache = {};
    safeRemove(CACHE_STORAGE);
    this.pool = [];
    this.queue = shuffled(this.corpus);
    this.stats.cacheHits = 0;
    this.emit();
  };

  /** Hand a labelled ticket to the simulation, or null if none is ready yet. */
  TicketLabeler.prototype.take = function () {
    var item = this.pool.length ? this.pool.shift() : null;
    this.refill();
    return item;
  };

  TicketLabeler.prototype.poolSize = function () {
    return this.pool.length;
  };

  TicketLabeler.prototype.nextTexts = function (count) {
    var out = [];
    while (out.length < count) {
      if (!this.queue.length) this.queue = shuffled(this.corpus);
      out.push(this.queue.shift());
    }
    return out;
  };

  /** Top the pool back up, serving from cache first and only then calling the API. */
  TicketLabeler.prototype.refill = function () {
    if (!this.enabled || this.stopped) return;
    if (this.pool.length >= POOL_TARGET) return;
    if (!this.hasApiKey()) {
      if (this.status !== 'needs-key') this.setStatus('needs-key');
      return;
    }
    if (this.inFlight) return;

    var batch = this.nextTexts(BATCH_SIZE);
    var uncached = [];
    var served = 0;

    for (var i = 0; i < batch.length; i++) {
      var cached = this.cache[this.cacheKey(batch[i])];
      if (cached) {
        this.pool.push({
          text: batch[i],
          label: cached.label,
          confidence: cached.confidence,
          probabilities: cached.probabilities,
          cached: true
        });
        this.stats.cacheHits++;
        served++;
      } else {
        uncached.push(batch[i]);
      }
    }

    if (served) this.emit();

    if (!uncached.length) {
      // Everything came from cache; keep filling until the pool is topped up.
      if (this.pool.length < POOL_TARGET) this.refill();
      return;
    }

    this.request(uncached);
  };

  /**
   * One request carrying every ticket in the batch as shared state, with one
   * independent `choice` question per ticket. The questions cannot see each
   * other's answers, which is exactly what we want: each ticket is judged on
   * its own text.
   */
  TicketLabeler.prototype.buildPayload = function (texts) {
    var state = { tickets: [] };
    var questions = {};

    for (var i = 0; i < texts.length; i++) {
      state.tickets.push({ index: i, text: texts[i] });
      questions['ticket_' + i] = {
        type: 'choice',
        instructions: INSTRUCTIONS_PREFIX + '`tickets[' + i + '].text`.',
        criteria: CRITERIA
      };
    }

    return { model: this.model, state: state, questions: questions };
  };

  TicketLabeler.prototype.request = function (texts) {
    var self = this;
    this.inFlight = true;
    this.setStatus('labelling');

    var attempt = 0;

    function run() {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);

      return global.fetch(self.baseURL + ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + self.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(self.buildPayload(texts)),
        signal: controller ? controller.signal : undefined
      }).then(function (res) {
        clearTimeout(timer);
        if (res.ok) return res.json();

        return res.text().then(function (body) {
          var err = new Error('TypeSafe API ' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
          err.status = res.status;
          // 401/403 will not fix themselves; anything else may be transient.
          err.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
          throw err;
        });
      }, function (netErr) {
        clearTimeout(timer);
        var err = new Error('TypeSafe request failed: ' + (netErr && netErr.message ? netErr.message : netErr));
        err.retryable = true;
        throw err;
      });
    }

    function attemptWithRetries() {
      return run().catch(function (err) {
        if (!err.retryable || attempt >= MAX_RETRIES) throw err;
        attempt++;
        var delay = Math.min(BACKOFF_INITIAL_MS * Math.pow(2, attempt - 1), BACKOFF_MAX_MS);
        delay = delay * (1 - Math.random() * 0.25);
        return new Promise(function (resolve) { setTimeout(resolve, delay); }).then(attemptWithRetries);
      });
    }

    attemptWithRetries().then(function (data) {
      self.inFlight = false;
      self.stats.requests++;

      if (data && data.usage) {
        self.stats.inputTokens += data.usage.input_tokens || 0;
        self.stats.outputTokens += data.usage.output_tokens || 0;
      }

      var answers = (data && data.answers) || {};

      for (var i = 0; i < texts.length; i++) {
        var answer = answers['ticket_' + i];
        if (!answer || typeof answer.choice !== 'string') continue;
        if (self.labels.indexOf(answer.choice) === -1) continue;

        var entry = {
          label: answer.choice,
          confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
          probabilities: answer.probabilities || null
        };

        self.cache[self.cacheKey(texts[i])] = entry;
        self.pool.push({
          text: texts[i],
          label: entry.label,
          confidence: entry.confidence,
          probabilities: entry.probabilities,
          cached: false
        });
        self.stats.labelled++;
      }

      self.saveCache();
      self.setStatus('ready');
      self.refill();
    }).catch(function (err) {
      self.inFlight = false;
      self.stats.failures++;

      // An auth or request error will repeat on every refill, so stop and let
      // the user fix the key rather than burning the rate limit in a loop.
      if (err.status === 401 || err.status === 403 || err.status === 400 || err.status === 422) {
        self.stopped = true;
      }
      self.setStatus('error', err.message || String(err));
    });
  };

  TicketLabeler.prototype.describeStatus = function () {
    switch (this.status) {
      case 'off': return 'Synthetic categories (TypeSafe off)';
      case 'needs-key': return 'Paste an API key to start labelling';
      case 'labelling': return 'Labelling tickets with ' + this.model + '…';
      case 'ready': return 'Labelled ' + this.stats.labelled + ' · pool ' + this.pool.length + ' · ' + this.stats.requests + ' requests';
      case 'error': return 'Error: ' + (this.lastError || 'unknown');
      default: return 'Idle';
    }
  };

  global.TypeSafeTickets = {
    TicketLabeler: TicketLabeler,
    CORPUS: CORPUS,
    CRITERIA: CRITERIA,
    DEFAULT_MODEL: DEFAULT_MODEL,
    BASE_URL: BASE_URL
  };
})(window);
