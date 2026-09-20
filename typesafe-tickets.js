/*
 * Ticket classification for the Evolve Data Sorting Simulation.
 *
 * The simulation normally hands each ticket a random category, so the agents are
 * only learning to match a colour. This module gives every ticket real support
 * text and has a classifier decide its category.
 *
 * The point is to measure a classifier honestly, so three things are kept apart:
 *
 *   gold       - the correct category, hand-written into the corpus below. This
 *                is the ground truth the simulation grades against. No
 *                classifier ever sees it.
 *   predicted  - what the selected classifier thought. This is what the agent
 *                is told it is carrying.
 *   confidence - how sure the classifier was, as a distribution.
 *
 * When a classifier is wrong the agent is misled: it carries the ticket to the
 * zone it was told, and the colony takes the penalty. Classification quality
 * therefore shows up directly in the simulation's score, and two classifiers can
 * be compared on identical tickets against an identical answer key:
 *
 *   'keyword' - a naive hand-written rule set. The no-AI baseline.
 *   'jev'     - TypeSafe System One, via the real API.
 *
 * API contract (verified against @typesafe-ai/sdk 0.6.0):
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <key>
 *   body: { model, state, questions: { <name>: { type: "choice", instructions, criteria } } }
 *   -> { model, usage, answers: { <name>: { type, choice, confidence, probabilities } } }
 */
(function (global) {
  'use strict';

  var BASE_URL = 'https://api.typesafe.ai';
  var ENDPOINT = '/v1/systemone';
  var DEFAULT_MODEL = 'jev-latest';

  // A same-origin serverless function that holds the key and forwards the call.
  // api.typesafe.ai sends no CORS headers, so a direct browser call fails before
  // it leaves the page - on a deployment that provides this path we use it, and
  // the key never touches the browser at all.
  var PROXY_PATH = 'api/typesafe';

  var KEY_STORAGE = 'foodsim.typesafe.apiKey';
  var CACHE_STORAGE = 'foodsim.typesafe.labelCache.v2';

  // Tickets per request. Each ticket is an independent question over one shared
  // state object, so they are answered in parallel in a single round trip.
  var BATCH_SIZE = 8;
  // Keep this many classified tickets ready so the simulation never blocks.
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
   * The corpus, with a hand-written gold label per ticket following the ITIL
   * distinction: incident = service is broken now, request = routine provision,
   * problem = the underlying cause behind repeated failures.
   *
   * These labels are the answer key. They are written here by hand, on purpose,
   * so that no classifier is ever graded against its own output. Some entries
   * are deliberately borderline - that is where the classifiers separate.
   */
  var CORPUS = [
    { gold: 'incident', text: 'Outlook has been stuck on "Trying to connect" since this morning. I cannot see any new mail and I have a client deadline at 14:00.' },
    { gold: 'request',  text: 'Could I get access to the shared Finance drive? My manager Anna has approved it, see the attached mail thread.' },
    { gold: 'problem',  text: 'This is the fourth time this month that the printer on floor 3 drops off the network after a reboot. Someone should look at why it keeps happening rather than just reconnecting it again.' },
    { gold: 'request',  text: 'Need a new laptop for a contractor starting on Monday. Standard developer image is fine.' },
    { gold: 'incident', text: 'The payment service returns 502 for roughly one in ten checkout attempts. Started about 40 minutes ago.' },
    { gold: 'request',  text: 'Please reset my password, I am locked out after too many attempts.' },
    { gold: 'problem',  text: 'VPN disconnects every 15-20 minutes for everyone in the Malmö office. Individually we have been raising tickets for weeks, I think there is a common cause.' },
    { gold: 'request',  text: 'Requesting a Photoshop licence for the marketing team, two seats.' },
    { gold: 'incident', text: 'My screen is completely black after the update last night. The machine powers on but nothing appears.' },
    { gold: 'request',  text: 'Can you install the new HR reporting tool on my workstation?' },
    { gold: 'problem',  text: 'Database replication lag has been climbing steadily and alerting fired twice overnight. Nothing is down yet but we should find the root cause before it is.' },
    { gold: 'incident', text: 'The coffee machine badge reader does not recognise my card any more.' },
    { gold: 'incident', text: 'All of Sales cannot log in to the CRM. Error says "authentication provider unavailable".' },
    { gold: 'request',  text: 'I would like a second monitor for my desk, please.' },
    { gold: 'problem',  text: 'Website images load very slowly from the Gothenburg office but fine from home. Been like that on and off for a while.' },
    { gold: 'request',  text: 'Someone deleted the Q3 folder from SharePoint. Can it be restored?' },
    { gold: 'incident', text: 'Laptop fan runs constantly and the machine is extremely hot to touch, it shut itself down twice today.' },
    { gold: 'request',  text: 'New starter in Logistics needs accounts for email, Slack and the warehouse system. Start date 1 October.' },
    { gold: 'problem',  text: 'We keep seeing intermittent "connection reset" errors between the API gateway and the order service. Different users, different times, same signature.' },
    { gold: 'request',  text: 'Please grant me admin rights on my own machine so I can install development tools.' },
    { gold: 'incident', text: 'The invoice export produced a file with no rows this morning. It worked yesterday.' },
    { gold: 'request',  text: 'Can you change my display name in the directory? It still shows my previous surname.' },
    { gold: 'problem',  text: 'Teams call quality is terrible for the whole department, choppy audio and frozen video since the network maintenance on Tuesday.' },
    { gold: 'request',  text: 'Requesting an increase to my mailbox quota, I am at 98%.' },
    { gold: 'problem',  text: 'Backup job for the file server has failed silently three nights running. No alert was raised, which is itself concerning.' },
    { gold: 'incident', text: 'My keyboard stopped working after I spilled water on it.' },
    { gold: 'request',  text: 'Need access to the staging environment for the new integration work.' },
    { gold: 'problem',  text: 'Users across several teams report that the search function returns no results for terms that definitely exist. Seems to have started after the index rebuild.' },
    { gold: 'request',  text: 'Could someone set up a distribution list for the project steering group?' },
    { gold: 'incident', text: 'The building door system is offline and staff cannot enter through the north entrance.' },
    { gold: 'incident', text: 'I get "certificate expired" when opening the internal wiki. Others see it too.' },
    { gold: 'request',  text: 'Please remove the leaver access for Johan Berg, last day was Friday.' },
    { gold: 'problem',  text: 'Mobile app crashes on launch for Android 14 users. We have had a dozen reports, and the crash signature is the same each time.' },
    { gold: 'request',  text: 'Requesting a docking station for the new laptop model.' },
    { gold: 'incident', text: 'Salesforce sync stopped overnight, no records have come through since 02:00.' },
    { gold: 'request',  text: 'Can I have the SPSS software installed for the analytics course?' },
    { gold: 'problem',  text: 'Every Monday morning the batch job queue backs up for about two hours. It clears on its own but it has been the same pattern since spring.' },
    { gold: 'incident', text: 'My headset microphone is not detected in any application.' },
    { gold: 'request',  text: 'Need a guest wifi code for visitors on Thursday, roughly 20 people.' },
    { gold: 'incident', text: 'The reporting dashboard shows last week numbers even after refresh. Finance are using it for a board pack today.' },
    { gold: 'request',  text: 'Please move my desk phone extension to the new seat, 4th floor east.' },
    { gold: 'problem',  text: 'Two different customers have reported the same duplicate-charge behaviour this week. I suspect the retry logic, can someone investigate properly?' },
    { gold: 'incident', text: 'Cannot open any PDF attachments, Acrobat throws an error on every file.' },
    { gold: 'request',  text: 'Requesting an upgrade to the standard storage allocation for our team share.' },
    { gold: 'problem',  text: 'The scheduled nightly data import has silently skipped records on and off for months. We patch the data each time but nobody has found why.' },
    { gold: 'incident', text: 'Server room temperature alarm is showing amber, on-site staff should check the AC unit.' },
    { gold: 'request',  text: 'Could you enable multi-factor authentication for my account?' },
    { gold: 'incident', text: 'The login page loads but the submit button does nothing for Safari users specifically.' }
  ];

  /*
   * The no-AI baseline: the sort of keyword rules you would write if you had to
   * classify these tickets without a model. Deliberately plausible rather than
   * deliberately bad - it scores each category by matched cues and takes the
   * highest. It has no notion of who is affected or whether a fault repeats,
   * which is exactly where it loses to a model that reads the sentence.
   */
  var KEYWORD_RULES = {
    request: ['please', 'could you', 'can you', 'could i', 'can i', 'would like',
      'request', 'need', 'access', 'licence', 'license', 'install', 'set up',
      'grant', 'reset', 'upgrade', 'enable', 'create', 'new'],
    incident: ['not working', 'does not', 'doesn\'t', 'cannot', 'can not', 'error',
      'fail', 'down', 'stuck', 'crash', 'offline', 'broken', 'unavailable',
      'stopped', 'slow', 'no longer'],
    problem: ['keeps', 'keep', 'again', 'recurring', 'root cause', 'common cause',
      'pattern', 'intermittent', 'investigate', 'repeatedly', 'every time',
      'several', 'multiple', 'why']
  };

  var LABELS = ['incident', 'request', 'problem'];

  /**
   * Score each category by matched cues and normalise into a distribution, so
   * the baseline produces the same shape of answer as the model and can feed
   * the same inputs. No match anywhere falls back to a flat distribution, which
   * is an honest "no idea" rather than a hidden guess at the most common label.
   */
  function classifyKeyword(text) {
    var lower = text.toLowerCase();
    var scores = {};
    var total = 0;

    for (var i = 0; i < LABELS.length; i++) {
      var label = LABELS[i];
      var cues = KEYWORD_RULES[label];
      var hits = 0;
      for (var j = 0; j < cues.length; j++) {
        if (lower.indexOf(cues[j]) !== -1) hits++;
      }
      scores[label] = hits;
      total += hits;
    }

    var probabilities = {};
    var best = LABELS[0];

    if (total === 0) {
      for (var k = 0; k < LABELS.length; k++) probabilities[LABELS[k]] = 1 / LABELS.length;
      // Nothing matched: pick one at random rather than silently favouring a
      // label, so the baseline's weakness shows honestly in its score.
      best = LABELS[Math.floor(Math.random() * LABELS.length)];
    } else {
      for (var m = 0; m < LABELS.length; m++) {
        probabilities[LABELS[m]] = scores[LABELS[m]] / total;
        if (scores[LABELS[m]] > scores[best]) best = LABELS[m];
      }
    }

    return {
      label: best,
      probabilities: probabilities,
      confidence: probabilities[best]
    };
  }

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
    this.labels = options.labels || LABELS.slice();
    this.model = options.model || DEFAULT_MODEL;
    this.baseURL = options.baseURL || BASE_URL;
    this.corpus = options.corpus || CORPUS;

    this.apiKey = safeGet(KEY_STORAGE) || '';
    this.enabled = false;
    this.inFlight = false;
    this.stopped = false;

    // 'jev' calls the API; 'keyword' runs the local baseline.
    this.classifier = 'jev';

    // 'proxy'   - a same-origin function holds the key and forwards the call
    // 'direct'  - no proxy on this deployment, the browser calls the API itself
    // 'unknown' - not probed yet
    this.mode = 'unknown';
    this.proxyConfigured = false;

    this.pool = [];
    this.queue = shuffled(this.corpus);
    this.cache = this.loadCache();

    this.status = 'idle';
    this.lastError = null;
    this.resetScores();
    this.listeners = [];
  }

  /** Per-classifier tally against the gold labels. */
  TicketLabeler.prototype.resetScores = function () {
    this.stats = { requests: 0, labelled: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
    this.scores = {
      jev: { correct: 0, graded: 0, confidenceSum: 0 },
      keyword: { correct: 0, graded: 0, confidenceSum: 0 }
    };
  };

  /** Classifier accuracy against the answer key, or null before any tickets. */
  TicketLabeler.prototype.accuracy = function (which) {
    var s = this.scores[which || this.classifier];
    if (!s || !s.graded) return null;
    return s.correct / s.graded;
  };

  TicketLabeler.prototype.record = function (which, predicted, gold, confidence) {
    var s = this.scores[which];
    if (!s) return;
    s.graded++;
    if (predicted === gold) s.correct++;
    if (typeof confidence === 'number') s.confidenceSum += confidence;
  };

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

  /** Whether a request can be authenticated: by the proxy, or by a pasted key. */
  TicketLabeler.prototype.hasApiKey = function () {
    if (this.mode === 'proxy') return this.proxyConfigured;
    return !!this.apiKey;
  };

  TicketLabeler.prototype.usesProxy = function () {
    return this.mode === 'proxy';
  };

  TicketLabeler.prototype.usesModel = function () {
    return this.classifier === 'jev';
  };

  /**
   * Ask the deployment whether it provides a proxy. A 404 (GitHub Pages, a
   * plain file server) simply means there is none, so we fall back to calling
   * the API from the browser and asking for a key.
   */
  TicketLabeler.prototype.detectProxy = function () {
    var self = this;
    if (this.modePromise) return this.modePromise;

    this.modePromise = global.fetch(PROXY_PATH, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }).then(function (res) {
      if (!res.ok) throw new Error('no proxy');
      return res.json();
    }).then(function (info) {
      if (!info || info.proxy !== true) throw new Error('no proxy');
      self.mode = 'proxy';
      self.proxyConfigured = !!info.configured;
      if (info.model) self.model = info.model;
    }).catch(function () {
      self.mode = 'direct';
      self.proxyConfigured = false;
    }).then(function () {
      self.emit();
      return self.mode;
    });

    return this.modePromise;
  };

  /** Switch classifier. Pooled tickets are dropped so the next ones come from it. */
  TicketLabeler.prototype.setClassifier = function (which) {
    if (which !== 'jev' && which !== 'keyword') return;
    if (this.classifier === which) return;
    this.classifier = which;
    this.pool = [];
    this.stopped = false;
    if (this.enabled) this.setEnabled(true);
    else this.emit();
  };

  TicketLabeler.prototype.setEnabled = function (on) {
    var self = this;
    this.enabled = !!on;
    this.stopped = false;

    if (!this.enabled) {
      this.setStatus('off');
      return;
    }

    // The baseline needs no network at all.
    if (!this.usesModel()) {
      this.setStatus('ready');
      this.refill();
      return;
    }

    this.setStatus('probing');
    this.detectProxy().then(function () {
      if (!self.enabled) return;
      self.setStatus(self.hasApiKey() ? 'idle' : 'needs-key');
      self.refill();
    });
  };

  TicketLabeler.prototype.clearCache = function () {
    this.cache = {};
    safeRemove(CACHE_STORAGE);
    this.pool = [];
    this.queue = shuffled(this.corpus);
    this.resetScores();
    this.emit();
  };

  /** Hand a classified ticket to the simulation, or null if none is ready yet. */
  TicketLabeler.prototype.take = function () {
    var item = this.pool.length ? this.pool.shift() : null;
    this.refill();
    return item;
  };

  TicketLabeler.prototype.poolSize = function () {
    return this.pool.length;
  };

  TicketLabeler.prototype.nextEntries = function (count) {
    var out = [];
    while (out.length < count) {
      if (!this.queue.length) this.queue = shuffled(this.corpus);
      out.push(this.queue.shift());
    }
    return out;
  };

  TicketLabeler.prototype.push = function (entry, prediction, cached) {
    this.record(this.classifier, prediction.label, entry.gold, prediction.confidence);
    this.pool.push({
      text: entry.text,
      gold: entry.gold,
      label: prediction.label,
      confidence: prediction.confidence,
      probabilities: prediction.probabilities,
      classifier: this.classifier,
      correct: prediction.label === entry.gold,
      cached: !!cached
    });
  };

  /** Top the pool back up, serving from cache first and only then calling the API. */
  TicketLabeler.prototype.refill = function () {
    if (!this.enabled || this.stopped) return;
    if (this.pool.length >= POOL_TARGET) return;

    // The baseline is local and instant.
    if (!this.usesModel()) {
      var entries = this.nextEntries(POOL_TARGET - this.pool.length);
      for (var n = 0; n < entries.length; n++) {
        this.push(entries[n], classifyKeyword(entries[n].text), false);
        this.stats.labelled++;
      }
      this.setStatus('ready');
      return;
    }

    if (!this.hasApiKey()) {
      if (this.status !== 'needs-key') this.setStatus('needs-key');
      return;
    }
    if (this.inFlight) return;

    var batch = this.nextEntries(BATCH_SIZE);
    var uncached = [];
    var served = 0;

    for (var i = 0; i < batch.length; i++) {
      var cached = this.cache[this.cacheKey(batch[i].text)];
      if (cached) {
        this.push(batch[i], cached, true);
        this.stats.cacheHits++;
        served++;
      } else {
        uncached.push(batch[i]);
      }
    }

    if (served) this.emit();

    if (!uncached.length) {
      if (this.pool.length < POOL_TARGET) this.refill();
      return;
    }

    this.request(uncached);
  };

  /**
   * One request carrying every ticket in the batch as shared state, with one
   * independent `choice` question per ticket. The questions cannot see each
   * other's answers, which is exactly what we want: each ticket is judged on
   * its own text. The gold labels are never sent.
   */
  TicketLabeler.prototype.buildPayload = function (entries) {
    var state = { tickets: [] };
    var questions = {};

    for (var i = 0; i < entries.length; i++) {
      state.tickets.push({ index: i, text: entries[i].text });
      questions['ticket_' + i] = {
        type: 'choice',
        instructions: INSTRUCTIONS_PREFIX + '`tickets[' + i + '].text`.',
        criteria: CRITERIA
      };
    }

    return { model: this.model, state: state, questions: questions };
  };

  TicketLabeler.prototype.request = function (entries) {
    var self = this;
    this.inFlight = true;
    this.setStatus('labelling');

    var attempt = 0;

    function run() {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);

      var url = self.usesProxy() ? PROXY_PATH : (self.baseURL + ENDPOINT);
      var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
      // Only the direct path carries a key; the proxy attaches its own.
      if (!self.usesProxy()) headers['Authorization'] = 'Bearer ' + self.apiKey;

      return global.fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(self.buildPayload(entries)),
        signal: controller ? controller.signal : undefined
      }).then(function (res) {
        clearTimeout(timer);
        if (res.ok) return res.json();

        return res.text().then(function (body) {
          var err = new Error('TypeSafe API ' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
          err.status = res.status;
          err.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
          throw err;
        });
      }, function (netErr) {
        clearTimeout(timer);
        var detail = (netErr && netErr.message) ? netErr.message : String(netErr);
        // A direct browser call to api.typesafe.ai is blocked by CORS, and the
        // browser reports it as an opaque network failure. Say what it means.
        var hint = self.usesProxy()
          ? 'TypeSafe proxy request failed: ' + detail
          : 'Blocked by the browser (CORS). api.typesafe.ai cannot be called ' +
            'directly from a page - deploy the included api/typesafe proxy. [' + detail + ']';
        var err = new Error(hint);
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

      for (var i = 0; i < entries.length; i++) {
        var answer = answers['ticket_' + i];
        if (!answer || typeof answer.choice !== 'string') continue;
        if (self.labels.indexOf(answer.choice) === -1) continue;

        var prediction = {
          label: answer.choice,
          confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
          probabilities: answer.probabilities || null
        };

        self.cache[self.cacheKey(entries[i].text)] = prediction;
        self.push(entries[i], prediction, false);
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
    var acc = this.accuracy();
    var accText = (acc === null) ? '' : ' · ' + (acc * 100).toFixed(0) + '% vs gold';

    switch (this.status) {
      case 'off': return 'Synthetic categories (classifier off)';
      case 'probing': return 'Looking for a server proxy…';
      case 'needs-key':
        return this.mode === 'proxy'
          ? 'Proxy found, but TYPESAFE_API_KEY is not set on the server'
          : 'Paste an API key to start classifying';
      case 'labelling': return 'Classifying with ' + this.model + '…';
      case 'ready':
        if (!this.usesModel()) {
          return 'Keyword baseline · ' + this.stats.labelled + ' classified' + accText;
        }
        return (this.usesProxy() ? 'Via server proxy · ' : '') +
          this.stats.labelled + ' classified · ' + this.stats.requests + ' requests' + accText;
      case 'error': return 'Error: ' + (this.lastError || 'unknown');
      default: return 'Idle';
    }
  };

  global.TypeSafeTickets = {
    TicketLabeler: TicketLabeler,
    classifyKeyword: classifyKeyword,
    CORPUS: CORPUS,
    CRITERIA: CRITERIA,
    LABELS: LABELS,
    DEFAULT_MODEL: DEFAULT_MODEL,
    BASE_URL: BASE_URL
  };
})(window);
