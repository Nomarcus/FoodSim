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
   * A second, small corpus for the duplicate-clustering demo. Three genuine
   * groups of three - the same underlying fault described by different people
   * in different words - plus three unrelated singletons.
   *
   * `group` is the answer key: two tickets belong together exactly when their
   * group matches. Nothing shares vocabulary with its own group by accident;
   * the overlap is in meaning, which is the point. Keyword matching cannot
   * find these, so the clustering is a real test rather than a light show.
   */
  var DUPLICATES = [
    { group: 'vpn', text: 'I keep getting dropped from the VPN every ten minutes or so and have to reconnect.' },
    { group: 'vpn', text: 'Remote access keeps cutting out. It comes back on its own but I lose whatever I was in the middle of.' },
    { group: 'vpn', text: 'Cannot stay connected to the company network from home this week \u2014 it drops constantly.' },
    { group: 'desk', text: 'Please order a standing desk for my office.' },

    { group: 'printer', text: 'The printer by the kitchen on floor 3 has gone offline again.' },
    { group: 'printer', text: 'Nobody on the third floor can print. The queue just sits there and nothing comes out.' },
    { group: 'printer', text: 'Third floor device is unreachable from my laptop, it says offline in the dialog.' },
    { group: 'adobe', text: 'I need the Adobe suite installed before Friday\u2019s workshop.' },

    { group: 'payroll', text: 'The payroll export produced an empty file this month.' },
    { group: 'payroll', text: 'Salary file came out with zero rows again when I ran the export.' },
    { group: 'payroll', text: 'The monthly run finished but the output has no records in it at all.' },
    { group: 'slack', text: 'Could you add me to the engineering Slack workspace?' },

    { group: 'wifi', text: 'Wireless in the upstairs meeting rooms is unusable during calls.' },
    { group: 'wifi', text: 'Every time we book the glass room the connection drops halfway through the presentation.' },
    { group: 'wifi', text: 'Signal upstairs is so weak that people join from their phones instead.' },
    { group: 'monitor', text: 'Requesting a second screen for the desk I moved to.' },

    { group: 'sso', text: 'Single sign-on sends me round in a loop and never lands on the app.' },
    { group: 'sso', text: 'Logging in bounces between the identity provider and the portal until it gives up.' },
    { group: 'sso', text: 'I authenticate, get redirected, and end up back at the sign-in page every time.' },
    { group: 'parking', text: 'How do I apply for a parking permit for the garage?' },

    { group: 'charging', text: 'My laptop stopped charging. The light on the adapter is on but the battery does not fill.' },
    { group: 'charging', text: 'Machine only runs on mains and dies the moment I unplug it.' },
    { group: 'charging', text: 'Battery sits at the same percentage all day even when connected to power.' },
    { group: 'course', text: 'I would like a seat on the project management course in November.' },

    { group: 'drive', text: 'I lost access to the shared project folder overnight, it says permission denied.' },
    { group: 'drive', text: 'The team directory I could open last week now refuses to let me in.' },
    { group: 'drive', text: 'Rights to our group storage seem to have been removed without anyone changing them.' },
    { group: 'quota', text: 'My mailbox is full again, can the limit be raised?' },

    { group: 'mail', text: 'Messages to external recipients take hours to arrive.' },
    { group: 'mail', text: 'Customers say my replies reach them the next morning instead of straight away.' },
    { group: 'mail', text: 'Outgoing post sits in the queue for a long time before it finally goes out.' },
    { group: 'cards', text: 'Need business cards printed with my new job title.' },

    { group: 'crm', text: 'The sales system times out whenever I open a large account.' },
    { group: 'crm', text: 'Customer records with a lot of history refuse to load and eventually error.' },
    { group: 'crm', text: 'Opening a big client page spins for a minute and then fails.' },
    { group: 'phone', text: 'My work phone is four years old, am I due for a replacement?' }
  ];


  /*
   * A second scenario: customer tickets for an office-supplies company, routed
   * on three axes at once - what kind of ticket it is, which team owns it, and
   * which product it concerns. This is the shape a first-line service desk
   * actually needs, and one request settles all three.
   *
   * Every ticket carries a hand-written key for all three. `product: 'none'` is
   * a real answer, not a gap: plenty of tickets are about an account or a
   * delivery window rather than a thing in the catalogue, and a classifier that
   * cannot say so will invent a product.
   */
  var TEAMS = {
    order:     'Order Desk \u2014 new orders, quantities, standing deliveries and catalogue questions.',
    billing:   'Billing \u2014 invoices, credit notes, pricing errors on a bill, payment and statements.',
    claims:    'Returns & Claims \u2014 goods that arrived damaged, faulty, wrong, or are being sent back.',
    logistics: 'Logistics \u2014 where and when goods arrive: delays, delivery windows, addresses, couriers.',
    accounts:  'Account Management \u2014 the commercial relationship: contracts, framework pricing, cost centres, new sites.'
  };

  var PRODUCTS = {
    pens:         'Ballpoint pens',
    highlighters: 'Highlighters',
    paper:        'A4 copy paper',
    notebooks:    'Notebooks',
    stickynotes:  'Sticky notes',
    binders:      'Ring binders',
    envelopes:    'Envelopes',
    toner:        'Printer toner',
    markers:      'Whiteboard markers',
    staplers:     'Staplers',
    clips:        'Paper clips',
    laminating:   'Laminating pouches',
    labels:       'Shipping labels',
    archiveboxes: 'Archive boxes',
    organisers:   'Desk organisers',
    none:         'No single product \u2014 the ticket is about an account, a delivery arrangement, a document, or the catalogue as a whole.'
  };

  var SUPPLY_TICKETS = [
    { team: 'order', product: 'paper', category: 'request', text: 'Could you add another twenty reams of A4 copy paper to our standing monthly order?' },
    { team: 'order', product: 'notebooks', category: 'request', text: 'We need sixty lined notebooks for the onboarding week in October.' },
    { team: 'order', product: 'toner', category: 'request', text: 'Please set up a recurring delivery of printer toner every eight weeks.' },
    { team: 'order', product: 'markers', category: 'request', text: 'Can we increase the whiteboard marker quantity from two packs to six per drop?' },
    { team: 'order', product: 'stickynotes', category: 'request', text: 'Add three hundred sticky note blocks to the next shipment please.' },
    { team: 'order', product: 'organisers', category: 'request', text: 'We would like to trial two desk organisers before ordering for the whole floor.' },
    { team: 'order', product: 'none', category: 'request', text: 'Could someone send the current catalogue with this year\u2019s prices?' },

    { team: 'billing', product: 'envelopes', category: 'incident', text: 'The invoice for last month lists forty boxes of envelopes but only thirty arrived.' },
    { team: 'billing', product: 'toner', category: 'incident', text: 'We were charged twice for the same toner delivery in August.' },
    { team: 'billing', product: 'binders', category: 'incident', text: 'The credit note for the returned ring binders has not appeared on our statement.' },
    { team: 'billing', product: 'paper', category: 'problem', text: 'Every quarter the copy paper is invoiced at list price instead of our agreed rate. It keeps coming back.' },
    { team: 'billing', product: 'none', category: 'request', text: 'Can you change the billing address on our account to the new head office?' },
    { team: 'billing', product: 'none', category: 'request', text: 'Please send copies of all invoices from the first half of the year.' },

    { team: 'claims', product: 'pens', category: 'incident', text: 'Half the ballpoint pens in the last carton were dry on arrival.' },
    { team: 'claims', product: 'paper', category: 'incident', text: 'Two reams of copy paper arrived water damaged and unusable.' },
    { team: 'claims', product: 'staplers', category: 'incident', text: 'The staplers we received jam on the third or fourth staple every time.' },
    { team: 'claims', product: 'highlighters', category: 'incident', text: 'A pack of highlighters leaked in transit and stained the rest of the box.' },
    { team: 'claims', product: 'labels', category: 'incident', text: 'The shipping labels do not stick \u2014 they peel off within an hour.' },
    { team: 'claims', product: 'laminating', category: 'problem', text: 'Third delivery running where the laminating pouches are the wrong size. Something is off in how the order is picked.' },
    { team: 'claims', product: 'clips', category: 'request', text: 'We would like to return an unopened box of paper clips ordered by mistake.' },

    { team: 'logistics', product: 'archiveboxes', category: 'incident', text: 'The pallet of archive boxes due Tuesday still has not reached the Malm\u00f6 site.' },
    { team: 'logistics', product: 'paper', category: 'incident', text: 'The courier left the paper order outside in the rain.' },
    { team: 'logistics', product: 'notebooks', category: 'problem', text: 'Shipments of notebooks to the Gothenburg office keep arriving a day late, month after month.' },
    { team: 'logistics', product: 'none', category: 'request', text: 'Can deliveries be moved to mornings? Our loading bay is blocked after lunch.' },
    { team: 'logistics', product: 'none', category: 'request', text: 'Please deliver to the rear entrance and call the number on the order.' },
    { team: 'logistics', product: 'none', category: 'request', text: 'Could you add a second drop point for our Uppsala branch?' },

    { team: 'accounts', product: 'none', category: 'request', text: 'We would like to renegotiate our annual pricing before the contract renews in November.' },
    { team: 'accounts', product: 'none', category: 'request', text: 'Can you add three new cost centres to our account so departments are billed separately?' },
    { team: 'accounts', product: 'none', category: 'request', text: 'We are opening two new offices and want them added to the framework agreement.' },
    { team: 'accounts', product: 'none', category: 'problem', text: 'Our account manager has changed four times this year and nobody knows our setup any more.' }
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

  /**
   * Per-classifier verdicts, keyed by ticket text so each ticket counts ONCE
   * however many times the simulation draws it. Counting handouts instead would
   * weight the score by how often a ticket happens to be drawn and inflate the
   * denominator into the tens of thousands.
   */
  TicketLabeler.prototype.resetScores = function () {
    this.stats = { requests: 0, labelled: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
    this.verdicts = { jev: {}, keyword: {} };
    this.scoreKeywordCorpus();
  };

  /**
   * The baseline is local and free, so score it over the whole corpus up front.
   * That way there is always something to compare the model against, without
   * having to run the simulation in baseline mode first.
   */
  TicketLabeler.prototype.scoreKeywordCorpus = function () {
    for (var i = 0; i < this.corpus.length; i++) {
      var entry = this.corpus[i];
      this.verdicts.keyword[entry.text] = classifyKeyword(entry.text).label === entry.gold;
    }
  };

  /** How many of the corpus's tickets this classifier has been scored on. */
  TicketLabeler.prototype.coverage = function (which) {
    return Object.keys(this.verdicts[which || this.classifier] || {}).length;
  };

  TicketLabeler.prototype.corpusSize = function () {
    return this.corpus.length;
  };

  /** Accuracy over unique tickets, or null before any have been scored. */
  TicketLabeler.prototype.accuracy = function (which) {
    var v = this.verdicts[which || this.classifier];
    if (!v) return null;
    var keys = Object.keys(v);
    if (!keys.length) return null;
    var correct = 0;
    for (var i = 0; i < keys.length; i++) if (v[keys[i]]) correct++;
    return correct / keys.length;
  };

  TicketLabeler.prototype.correctCount = function (which) {
    var v = this.verdicts[which || this.classifier];
    if (!v) return 0;
    var keys = Object.keys(v), correct = 0;
    for (var i = 0; i < keys.length; i++) if (v[keys[i]]) correct++;
    return correct;
  };

  TicketLabeler.prototype.record = function (which, text, predicted, gold) {
    if (!this.verdicts[which]) return;
    this.verdicts[which][text] = predicted === gold;
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
    this.record(this.classifier, entry.text, prediction.label, entry.gold);
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
      if (this.pool.length < POOL_TARGET) {
        this.refill();
      } else {
        // Every ticket came from cache, so no request is made and the status
        // would otherwise sit at 'idle' forever - making a working run look
        // like one still connecting.
        this.setStatus('ready');
      }
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
    var accText = (acc === null) ? '' : ' · ' + (acc * 100).toFixed(0) + '% vs gold (' +
      this.correctCount() + '/' + this.coverage() + ')';

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


  /*
   * Parcels for the conveyor experiment.
   *
   * Twenty bins, and a delivery note that never names its own bin: nothing here
   * says "toner" or "chair". The category has to be worked out from what the
   * note describes, which is the whole point - a keyword rule has nothing to
   * match on, and "a 14-inch notebook computer" has to land in laptops rather
   * than notebooks.
   *
   * `gold` is the hand-written answer key. It is used to colour the bins after
   * the fact and is never sent with the parcel.
   */
  var PARCEL_BINS = [
    { key: 'paper',      name: 'Paper',        criteria: 'Blank paper and pads - reams, flip-chart pads, till rolls, card stock.' },
    { key: 'toner',      name: 'Toner & ink',  criteria: 'Printer and copier consumables - toner, ink, drums, waste containers.' },
    { key: 'writing',    name: 'Pens',         criteria: 'Handheld writing and marking - pens, pencils, markers, highlighters.' },
    { key: 'notebooks',  name: 'Notebooks',    criteria: 'Bound paper to write in - notebooks, pads, diaries, planners. Not computers.' },
    { key: 'envelopes',  name: 'Post',         criteria: 'Things used to send post - envelopes, mailers, document sleeves, postage labels.' },
    { key: 'batteries',  name: 'Batteries',    criteria: 'Cells and battery packs of any size, and chargers for them.' },
    { key: 'cables',     name: 'Cables',       criteria: 'Leads, adapters and plugs that connect or power something else.' },
    { key: 'keyboards',  name: 'Keyboards',    criteria: 'Keyboards and number pads.' },
    { key: 'mice',       name: 'Mice',         criteria: 'Pointing devices - mice, trackballs, vertical pointers, and wrist rests for them.' },
    { key: 'monitors',   name: 'Monitors',     criteria: 'Standalone screens and the arms or stands that hold them.' },
    { key: 'laptops',    name: 'Laptops',      criteria: 'Portable computers and docks. A "notebook computer" belongs here, not with notebooks.' },
    { key: 'phones',     name: 'Phones',       criteria: 'Telephones - mobile handsets, desk phones, SIMs and cases for them.' },
    { key: 'headsets',   name: 'Headsets',     criteria: 'Anything worn or placed to listen and speak - headphones, earbuds, speakerphones.' },
    { key: 'chairs',     name: 'Chairs',       criteria: 'Seating and its spare parts - task chairs, stools, gas lifts, armrests.' },
    { key: 'desks',      name: 'Desks',        criteria: 'Desks, worktops, frames and the trays fixed to them.' },
    { key: 'lamps',      name: 'Lighting',     criteria: 'Lighting - lamps, bulbs, tubes, uplighters.' },
    { key: 'cleaning',   name: 'Cleaning',     criteria: 'Cleaning materials and equipment, including sanitiser and blue roll.' },
    { key: 'coffee',     name: 'Coffee & tea', criteria: 'Hot drinks and what the machines need - beans, capsules, tea, milk, descaler, filters.' },
    { key: 'snacks',     name: 'Snacks',       criteria: 'Food to eat as it is - bars, nuts, crisps, biscuits, cereal.' },
    { key: 'firstaid',   name: 'First aid',    criteria: 'Medical supplies - dressings, eyewash, burn gel, defibrillator pads.' }
  ];

  var PARCELS = [
    { gold: 'paper', text: 'Five reams, 80 gsm, A4, still shrink-wrapped.' },
    { gold: 'paper', text: 'A flat box of perforated pads for the flip chart stand.' },
    { gold: 'paper', text: 'Two boxes of thermal rolls for the reception till.' },
    { gold: 'paper', text: 'Heavyweight cream stock for printing the certificates.' },
    { gold: 'toner', text: 'A sealed cartridge for the fourth-floor colour copier.' },
    { gold: 'toner', text: 'Waste container and a drum unit for the big Ricoh.' },
    { gold: 'toner', text: 'Black refill, high yield, for the HP on 2B.' },
    { gold: 'toner', text: 'A twin pack of tanks for the wide-format plotter.' },
    { gold: 'writing', text: 'A gross of black ballpoints, fine tip.' },
    { gold: 'writing', text: 'Four packs of dry-wipe markers for the whiteboards.' },
    { gold: 'writing', text: 'Mechanical pencils and a tub of 0.5 leads.' },
    { gold: 'writing', text: 'Highlighters in five colours, boxed.' },
    { gold: 'notebooks', text: 'Twenty A5 hardbacks, squared, for the new starters.' },
    { gold: 'notebooks', text: 'Week-to-view planners for next year.' },
    { gold: 'notebooks', text: 'Spiral bound pads, perforated, lined.' },
    { gold: 'notebooks', text: 'A box of leather-bound journals for the board.' },
    { gold: 'envelopes', text: 'A thousand C5 self-seal with a window.' },
    { gold: 'envelopes', text: 'Padded bubble mailers, size 4.' },
    { gold: 'envelopes', text: 'Cardboard document sleeves, A4, do not bend.' },
    { gold: 'envelopes', text: 'Rolls of labels for the franking machine.' },
    { gold: 'batteries', text: 'Bulk pack of AA alkaline for the wireless pointers.' },
    { gold: 'batteries', text: 'Button cells for the door access fobs.' },
    { gold: 'batteries', text: 'Rechargeable AAA cells and their charging dock.' },
    { gold: 'batteries', text: 'A spare 9V pack for the smoke alarms.' },
    { gold: 'cables', text: 'Two-metre USB-C to USB-C, braided.' },
    { gold: 'cables', text: 'HDMI leads for the meeting rooms.' },
    { gold: 'cables', text: 'A box of Cat6 patch leads, various lengths.' },
    { gold: 'cables', text: 'Travel adapters, UK to EU, ten of them.' },
    { gold: 'keyboards', text: 'Wireless, Nordic layout, low profile.' },
    { gold: 'keyboards', text: 'Two mechanical boards with brown switches.' },
    { gold: 'keyboards', text: 'A split ergonomic board for the fourth desk.' },
    { gold: 'keyboards', text: 'Numeric pads for the finance team.' },
    { gold: 'mice', text: 'Wireless optical, five of them, black.' },
    { gold: 'mice', text: 'A vertical ergonomic pointer for the support desk.' },
    { gold: 'mice', text: 'A trackball for the design bench.' },
    { gold: 'mice', text: 'Gel wrist rests and two pointing devices.' },
    { gold: 'monitors', text: 'A 27-inch panel, boxed, screen film still on.' },
    { gold: 'monitors', text: 'Two ultrawide panels for the trading desk.' },
    { gold: 'monitors', text: 'Mounting arms and a 24-inch display.' },
    { gold: 'monitors', text: 'A portable 15-inch second screen for travel.' },
    { gold: 'laptops', text: 'A 14-inch notebook computer, sealed, with its charger.' },
    { gold: 'laptops', text: 'Three refurbished machines for the interns.' },
    { gold: 'laptops', text: 'A docking station and the portable it pairs with.' },
    { gold: 'laptops', text: 'Slim aluminium ultrabook, 16 GB, in retail packaging.' },
    { gold: 'phones', text: 'Two handsets and a pair of SIM trays.' },
    { gold: 'phones', text: 'A rugged mobile for the warehouse staff.' },
    { gold: 'phones', text: 'DECT desk sets for reception.' },
    { gold: 'phones', text: 'Screen protectors and a mid-range handset.' },
    { gold: 'headsets', text: 'USB headphones with a boom mic, ten of them.' },
    { gold: 'headsets', text: 'Noise-cancelling over-ears for the open plan.' },
    { gold: 'headsets', text: 'A conference speakerphone for the small room.' },
    { gold: 'headsets', text: 'Wireless earbuds with a charging case.' },
    { gold: 'chairs', text: 'A task seat, mesh back, on castors, flat-packed.' },
    { gold: 'chairs', text: 'Four stools for the standing benches.' },
    { gold: 'chairs', text: 'Visitor seating, stackable, six of them.' },
    { gold: 'chairs', text: 'A replacement gas lift and a pair of armrests.' },
    { gold: 'desks', text: 'A sit-stand frame, motorised, in two boxes.' },
    { gold: 'desks', text: 'Worktops, oak veneer, 160 by 80.' },
    { gold: 'desks', text: 'Cable trays and the bench workstation they bolt to.' },
    { gold: 'desks', text: 'A corner unit for office 3B.' },
    { gold: 'lamps', text: 'A task light with a clamp base.' },
    { gold: 'lamps', text: 'LED tubes for the ceiling fittings.' },
    { gold: 'lamps', text: 'Two floor uplighters for the lounge.' },
    { gold: 'lamps', text: 'Daylight bulbs, warm white, box of twelve.' },
    { gold: 'cleaning', text: 'Surface spray and a case of blue roll.' },
    { gold: 'cleaning', text: 'Mop heads and a bucket with a wringer.' },
    { gold: 'cleaning', text: 'Bags for the upright in the cupboard.' },
    { gold: 'cleaning', text: 'Hand sanitiser, five litres, refill.' },
    { gold: 'coffee', text: 'A kilo of beans, dark roast, for the grinder.' },
    { gold: 'coffee', text: 'Descaler and filters for the machine on 3.' },
    { gold: 'coffee', text: 'Assorted teas and a box of oat drink.' },
    { gold: 'coffee', text: 'Capsules, two hundred, for the small machine.' },
    { gold: 'snacks', text: 'Fruit bars and mixed nuts for the kitchen.' },
    { gold: 'snacks', text: 'Crisps in multipacks for the Friday session.' },
    { gold: 'snacks', text: 'Biscuits, assorted, two tins.' },
    { gold: 'snacks', text: 'Cereal and instant porridge pots.' },
    { gold: 'firstaid', text: 'A cabinet restock: plasters, tape and gauze.' },
    { gold: 'firstaid', text: 'An eyewash station refill.' },
    { gold: 'firstaid', text: 'Burn gel and a foil blanket.' },
    { gold: 'firstaid', text: 'Defibrillator pads, in date until next year.' }
  ];


  /*
   * Where a sorted parcel is driven next.
   *
   * Thirty sites, and a shipping note that never names one. "Leave it with the
   * crane crew on the cold store side" is the harbour; "the night gang setting
   * up before the first race" is the racetrack. The note is independent of what
   * is in the parcel, so the second decision cannot be inferred from the first -
   * the same box of batteries can be going to the observatory or the ferry.
   *
   * `gold` is the hand-written answer key, and is never sent.
   */
  var SITES = [
    { key: 'harbour',    name: 'Harbour depot',   criteria: 'The docks: cranes, containers, the cold store, ships being unloaded.' },
    { key: 'airport',    name: 'Airport hub',     criteria: 'The airport: aircraft stands, baggage halls, the runway apron.' },
    { key: 'academy',    name: 'Academy campus',  criteria: 'A teaching campus: lecture halls, classrooms, students and tutors.' },
    { key: 'hospital',   name: "St Anne's",       criteria: 'A hospital: wards, theatres, nursing staff, patients.' },
    { key: 'stadium',    name: 'The stadium',     criteria: 'A sports stadium: stands, pitch, turnstiles, match days.' },
    { key: 'brewery',    name: 'The brewery',     criteria: 'A brewery: mash tuns, fermenters, kegs and casks.' },
    { key: 'foundry',    name: 'The foundry',     criteria: 'A metal foundry: furnaces, molten pours, castings.' },
    { key: 'datacentre', name: 'Datacentre',      criteria: 'A datacentre: server halls, cold aisles, racks and cooling.' },
    { key: 'museum',     name: 'City museum',     criteria: 'A museum: galleries, exhibits, display cases, curators.' },
    { key: 'observatory',name: 'Observatory',     criteria: 'An observatory: telescopes, the dome, night observing runs.' },
    { key: 'quarry',     name: 'The quarry',      criteria: 'A stone quarry: blasting, crushers, haul trucks, dust.' },
    { key: 'vineyard',   name: 'The vineyard',    criteria: 'A vineyard: vines, the harvest, the press house.' },
    { key: 'ferry',      name: 'Ferry terminal',  criteria: 'A ferry terminal: car decks, the ramp, foot passengers, sailings.' },
    { key: 'refinery',   name: 'The refinery',    criteria: 'A refinery: distillation columns, flare stack, pipework, permits.' },
    { key: 'sawmill',    name: 'The sawmill',     criteria: 'A sawmill: logs, the green chain, blades, stacked timber.' },
    { key: 'aquarium',   name: 'The aquarium',    criteria: 'An aquarium: tanks, the reef display, divers feeding fish.' },
    { key: 'printworks', name: 'The printworks',  criteria: 'A printing works: presses, plates, the folding line, print runs.' },
    { key: 'granary',    name: 'The granary',     criteria: 'A grain store: silos, augers, the weighbridge, harvest intake.' },
    { key: 'racetrack',  name: 'The racetrack',   criteria: 'A racing circuit: the pit lane, grandstands, race days.' },
    { key: 'coastguard', name: 'Coastguard',      criteria: 'A coastguard station: the lifeboat, call-outs, the watch room.' },
    { key: 'studio',     name: 'Film studio',     criteria: 'A film studio: sound stages, the props store, a shoot in progress.' },
    { key: 'bakery',     name: 'Central bakery',  criteria: 'A bakery: ovens, the proving room, the night bake.' },
    { key: 'laundry',    name: 'The laundry',     criteria: 'An industrial laundry: washers, the press line, linen rounds.' },
    { key: 'greenhouse', name: 'The greenhouses', criteria: 'Glasshouses: seedlings, irrigation, the growing benches.' },
    { key: 'archive',    name: 'The archive',     criteria: 'A records archive: boxed files, the reading room, cataloguing.' },
    { key: 'fishmarket', name: 'Fish market',     criteria: 'A fish market: the auction floor, ice, early morning trade.' },
    { key: 'garage',     name: 'Bus garage',      criteria: 'A bus garage: the pits, the wash, drivers signing on.' },
    { key: 'lighthouse', name: 'The lighthouse',  criteria: 'A lighthouse: the lamp room, the keeper, the cliff path.' },
    { key: 'library',    name: 'Central library',  criteria: 'A public library: the stacks, the issue desk, the reading rooms.' },
    { key: 'icerink',    name: 'The ice rink',    criteria: 'An ice rink: the pad, the resurfacer, skate hire, the plant room.' }
  ];

  var SHIPPING = [
    { gold: 'harbour', text: 'Leave it with the crane crew on the cold store side.' },
    { gold: 'harbour', text: 'The night gang unloading the container ship are asking for it.' },
    { gold: 'airport', text: 'Airside, stand 14 — the baggage hall office will sign for it.' },
    { gold: 'airport', text: 'Needed before the first departures, by the apron gate.' },
    { gold: 'academy', text: 'For the lecture theatre on the second floor, before term starts.' },
    { gold: 'academy', text: 'The tutors want it in the seminar rooms for freshers week.' },
    { gold: 'hospital', text: 'Ward 6 asked twice; leave it at the nursing station.' },
    { gold: 'hospital', text: 'Theatre stores, and it cannot wait until after the list.' },
    { gold: 'stadium', text: 'Under the north stand, before the turnstiles open.' },
    { gold: 'stadium', text: 'The groundsman wants it pitchside on a match day.' },
    { gold: 'brewery', text: 'Next to the fermenters, the mash is on at six.' },
    { gold: 'brewery', text: 'For the keg line crew, before the Friday racking.' },
    { gold: 'foundry', text: 'Drop it by the furnace floor office, not the yard.' },
    { gold: 'foundry', text: 'The pour is at eleven and the casting team need it first.' },
    { gold: 'datacentre', text: 'Cold aisle 4, and ring the hall before you badge in.' },
    { gold: 'datacentre', text: 'For the rack build, goods-in is behind the chillers.' },
    { gold: 'museum', text: 'The curator wants it before the new gallery opens.' },
    { gold: 'museum', text: 'Round the back, past the display cases being crated.' },
    { gold: 'observatory', text: 'Up the hill road, and only between observing runs.' },
    { gold: 'observatory', text: 'The dome crew need it before tonight, while it is light.' },
    { gold: 'quarry', text: 'Site office by the crusher, and mind the haul road.' },
    { gold: 'quarry', text: 'Not during blasting — leave it at the weigh hut.' },
    { gold: 'vineyard', text: 'Up at the press house, they are picking all week.' },
    { gold: 'vineyard', text: 'Between the rows is fine, the pickers are on the south slope.' },
    { gold: 'ferry', text: 'Before the 07:40 sailing, by the vehicle ramp.' },
    { gold: 'ferry', text: 'Foot passenger entrance, the car deck crew will take it.' },
    { gold: 'refinery', text: 'Permit needed at the gate; the column 3 team asked for it.' },
    { gold: 'refinery', text: 'Not past the flare stack — use the east pipework gate.' },
    { gold: 'sawmill', text: 'By the green chain, the log deck is blocked this week.' },
    { gold: 'sawmill', text: 'For the blade shop, before the timber stack is moved.' },
    { gold: 'aquarium', text: 'Behind the reef tank, ask for the dive team.' },
    { gold: 'aquarium', text: 'Before feeding, and keep it away from the sea water line.' },
    { gold: 'printworks', text: 'Press hall, before the overnight run starts.' },
    { gold: 'printworks', text: 'The plate room want it — the folder is down until it arrives.' },
    { gold: 'granary', text: 'Over the weighbridge first, then the silo office.' },
    { gold: 'granary', text: 'Intake is flat out with the harvest; leave it by the augers.' },
    { gold: 'racetrack', text: 'Pit lane, and only before the circuit goes live.' },
    { gold: 'racetrack', text: 'The night gang setting up the grandstands are waiting on it.' },
    { gold: 'coastguard', text: 'The watch room, and not while the boat is out on a shout.' },
    { gold: 'coastguard', text: 'Leave it with the crew at the slipway.' },
    { gold: 'studio', text: 'Stage 2, and they are shooting until seven so knock first.' },
    { gold: 'studio', text: 'For the props store, before the set is struck.' },
    { gold: 'bakery', text: 'Before the night bake, the ovens are on from ten.' },
    { gold: 'bakery', text: 'By the proving room door, not the loading yard.' },
    { gold: 'laundry', text: 'The press line is short and the linen round leaves at five.' },
    { gold: 'laundry', text: 'Goods-in past the washers, ask for the shift lead.' },
    { gold: 'greenhouse', text: 'Down by the growing benches, the seedlings go out Monday.' },
    { gold: 'greenhouse', text: 'The irrigation crew want it inside the glass, not the yard.' },
    { gold: 'archive', text: 'The reading room is closed, so use the cataloguing door.' },
    { gold: 'archive', text: 'For the boxed files on level -1, before the audit.' },
    { gold: 'fishmarket', text: 'Before the auction, and it has to be on the floor by four.' },
    { gold: 'fishmarket', text: 'Next to the ice machine, the early traders will take it.' },
    { gold: 'garage', text: 'Over the pits, the drivers sign on at half four.' },
    { gold: 'garage', text: 'Past the wash, and not in the way of the morning pull-out.' },
    { gold: 'lighthouse', text: 'Up the cliff path, the keeper is expecting it.' },
    { gold: 'lighthouse', text: 'For the lamp room, and only in daylight.' },
    { gold: 'library', text: 'The issue desk will take it, the stacks are being moved.' },
    { gold: 'library', text: 'Before the reading rooms open to the public.' },
    { gold: 'icerink', text: 'Plant room, and after the resurfacer has been round.' },
    { gold: 'icerink', text: 'Skate hire counter, before the public session.' }
  ];

  global.TypeSafeTickets = {
    TicketLabeler: TicketLabeler,
    classifyKeyword: classifyKeyword,
    CORPUS: CORPUS,
    DUPLICATES: DUPLICATES,
    SUPPLY_TICKETS: SUPPLY_TICKETS,
    PARCEL_BINS: PARCEL_BINS,
    PARCELS: PARCELS,
    SITES: SITES,
    SHIPPING: SHIPPING,
    TEAMS: TEAMS,
    PRODUCTS: PRODUCTS,
    CRITERIA: CRITERIA,
    LABELS: LABELS,
    DEFAULT_MODEL: DEFAULT_MODEL,
    BASE_URL: BASE_URL
  };
})(window);
