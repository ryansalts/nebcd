// NEBCD — build.js
// Reads _data/*.json, renders *.template.html files, and writes the finished
// site to _site/ (only _site/ is published). Edit templates, not the .html files.
// Run: node build.js
// GitHub Actions runs this on every push to main and once a night (see .github/workflows/build.yml).

const fs    = require('fs');
const https = require('https');
const path  = require('path');

// ── Load data ──────────────────────────────────────────────────────────────

function readData(file, fallback = {}) {
  const path = `_data/${file}`;
  return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : fallback;
}

// Candidates live in endorsements.json and representatives in representatives.json
// (both under 🗳️ Elections). Site settings are split into one file per admin screen:
//   homepage.json   → 🏠 Homepage
//   office.json     → 📍 Office & Contact
//   links.json      → 🔗 Links & Accounts
//   elections.json  → 🗳️ Elections → Election Page Text & Voting Resources
//   site-mode.json  → ⚙️ Site Mode
// _data/settings.json is the old all-in-one file. If it still exists it's read
// first, and anything in the new files takes priority, so the site keeps
// working during the switchover. It can be deleted once the new files are in.
const SETTINGS_FILES = ['homepage.json', 'office.json', 'links.json', 'elections.json', 'site-mode.json'];
const foundSettingsFiles = ['settings.json', ...SETTINGS_FILES].filter(f => fs.existsSync(`_data/${f}`));
if (!foundSettingsFiles.length) {
  // Fail the build (the live site stays as it was) rather than publish a broken site.
  throw new Error('No settings files found in _data/. Expected homepage.json, office.json, links.json, elections.json and site-mode.json.');
}
const settings = Object.assign({}, readData('settings.json'), ...SETTINGS_FILES.map(f => readData(f)));

const events       = readData('events.json', { events: [] }).events || [];
const endorsements = readData('endorsements.json', { endorsements: [] }).endorsements || [];
const storeData    = readData('store.json', { store_intro: '', products: [] });
const sponsorData  = readData('sponsor.json', { sponsor_intro: '', events: [] });
const repsData     = readData('representatives.json', { representatives: [], lookup_links: [] });
const representatives = repsData.representatives || [];
// 👥 Leadership in the admin: names (and optional titles) shown on the homepage.
const leadershipData = readData('leadership.json', { show_leadership: false, members: [] });
const leaders = (leadershipData.members || []).filter(m => m && String(m.name || '').trim());

// ── Dates (always Central time, since GitHub's servers run on UTC) ─────────
const TIME_ZONE = 'America/Chicago';
// Today's date in Central time as YYYY-MM-DD, e.g. "2026-10-05"
const todayCentral = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const currentYear = todayCentral.slice(0, 4);

// ── Defaults for settings that may be blank ────────────────────────────────
const DEFAULT_MOBILIZE_URL     = 'https://www.mobilize.us/nebcd/';
const DEFAULT_GET_INVOLVED_URL = 'https://join.nebcd.org/m/volunteer';

const mobilizeUrl   = settings.mobilize_url || DEFAULT_MOBILIZE_URL;
const getInvolvedUrl = settings.get_involved_url || DEFAULT_GET_INVOLVED_URL;
// Phone link digits are worked out from the phone number, e.g. "210-917-1790" → "2109171790".
// If the phone is left blank in the CMS, every phone number and "Call" button is left off the site.
const officePhoneHref = String(settings.office_phone || '').replace(/\D/g, '');
const hasPhone = officePhoneHref.length > 0;

// Blank image/text fields fall back to these, so the site never shows an empty spot.
const orDefault = (value, fallback) => (value && String(value).trim()) ? String(value).trim() : fallback;
const assetPath = p => String(p || '').replace(/^\/+/, '');   // "/assets/x.webp" → "assets/x.webp"
const shareImage    = assetPath(orDefault(settings.share_image, 'assets/NEBCD-Office.webp'));
const meetingText   = orDefault(settings.meeting_text, '2nd Saturday of each month, 10 a.m. to noon.');
const missionPhotos = [
  { src: assetPath(orDefault(settings.mission_photo_1, 'assets/nebcd-event.webp')),
    alt: orDefault(settings.mission_photo_1_alt, 'NEBCD members at a community event') },
  { src: assetPath(orDefault(settings.mission_photo_2, 'assets/nebcd-dining-with-dems.webp')),
    alt: orDefault(settings.mission_photo_2_alt, 'Dining with Democrats event 2025') },
];

// ── Season ─────────────────────────────────────────────────────────────────
// Set in the CMS: ⚙️ Site Mode → Off-Season Mode.
// Off (the default) = campaign season: office, store and Mobilize shifts are shown.
// On = between elections: the office, store and Mobilize are taken down together
// (their content is kept for next time). Worded as "Off-Season Mode" so a switch
// that was never set always means the normal, open site.
const offSeason = settings.off_season === true;
const inSeason  = !offSeason;
// Mobilize shifts show in campaign season, or in the off-season too if
// ⚙️ Site Mode → "Keep Mobilize On in Off-Season" is switched on.
const showMobilize = inSeason || settings.mobilize_off_season === true;

// Club Leadership section: shown when 👥 Leadership → Show Leadership is on and at least one name is listed.
const showLeadership = leadershipData.show_leadership === true && leaders.length > 0;

// ── Election page mode ─────────────────────────────────────────────────────
// Set in the CMS: ⚙️ Site Mode → Election Page Mode.
//   "endorsements"    = endorsed candidates (before the primary)
//   "election"        = election guide covering all candidates (after the primary)
//   "representatives" = Connect With Your Representatives (after results are final)
//   "hidden"          = page taken down; a short notice is shown at its address
// The URL stays /endorsements in every mode so existing links keep working.
// Election year: uses the CMS value, or the current year if left blank.
const cycle = settings.endorsements_cycle_label || currentYear;
const PAGE_MODES = ['endorsements', 'election', 'representatives', 'hidden'];
const pageMode = PAGE_MODES.includes(settings.endorsements_page_mode) ? settings.endorsements_page_mode : 'endorsements';
const isElectionMode = pageMode === 'election';
const isRepsMode     = pageMode === 'representatives';
const electionPageOn = pageMode !== 'hidden';
// Election season = the Election page is in Endorsements or Election Guide mode.
// It decides the order of the menu, the footer links and the homepage sections
// (see SITE_MENU and HOME_SECTION_ORDER below).
const electionSeason = pageMode === 'endorsements' || pageMode === 'election';

const PAGE_TEXT = {
  election: {
    navLabel:          'Election',
    breadcrumb:        'Election Guide',
    eyebrow:           `${cycle} Elections`,
    heading:           'NEBCD Election Guide',
    title:             `${cycle} Election Guide | North East Bexar County Democrats | NEBCD`,
    description:       `NEBCD's ${cycle} guide to the candidates on the ballot in Bexar County elections.`,
    keywords:          `NEBCD election guide ${cycle}, Bexar County voter guide, Bexar County candidates, San Antonio election ${cycle}`,
    socialTitle:       `${cycle} Election Guide | NEBCD`,
    socialDescription: `Meet the candidates on the ${cycle} ballot in Bexar County, a guide from the North East Bexar County Democrats.`,
    schemaName:        `NEBCD ${cycle} Election Guide Candidates`,
    schemaDescription: `Candidates on the ${cycle} Bexar County ballot, compiled by the North East Bexar County Democrats.`,
    homeHeading:       `${cycle} Election Guide`,
    homeButton:        'View the Election Guide →',
    heroButton:        'View the Election Guide',
    resourcesHeading:  'Know Before You Vote',
    intro:             orDefault(settings.endorsements_intro, `NEBCD's guide to the candidates on your ${cycle} ballot.`),
  },
  endorsements: {
    navLabel:          'Endorsements',
    breadcrumb:        'Endorsements',
    eyebrow:           `${cycle} Elections`,
    heading:           'NEBCD Endorsements',
    title:             `${cycle} Endorsements | North East Bexar County Democrats | NEBCD`,
    description:       `NEBCD's ${cycle} endorsed candidates for Bexar County elections.`,
    keywords:          `NEBCD endorsements ${cycle}, Bexar County Democrats endorsements, San Antonio school board election, Democratic endorsements Texas`,
    socialTitle:       `${cycle} Endorsements | NEBCD`,
    socialDescription: `See which candidates the North East Bexar County Democrats endorse for the ${cycle} elections in Bexar County.`,
    schemaName:        `NEBCD ${cycle} Endorsed Candidates`,
    schemaDescription: `North East Bexar County Democrats endorsements for the ${cycle} Bexar County elections.`,
    homeHeading:       'Our Endorsements',
    homeButton:        'View All Endorsements →',
    heroButton:        'See Our Endorsements',
    resourcesHeading:  'Know Before You Vote',
    intro:             orDefault(settings.intro_endorsements, `NEBCD proudly endorses these candidates for the ${cycle} election cycle.`),
  },
  representatives: {
    navLabel:          'Find Your Reps',
    breadcrumb:        'Your Representatives',
    eyebrow:           'Stay Connected',
    heading:           'Connect With Your Representatives',
    title:             'Connect With Your Representatives | North East Bexar County Democrats | NEBCD',
    description:       'Find and contact the elected officials who represent Northeast San Antonio and Bexar County, from Congress to the county courthouse.',
    keywords:          'contact my representative San Antonio, Bexar County elected officials, Northeast San Antonio representatives, Texas legislators Bexar County, NEBCD',
    socialTitle:       'Connect With Your Representatives | NEBCD',
    socialDescription: 'Who represents you, and how to reach them: elected officials for Northeast San Antonio and Bexar County.',
    schemaName:        'Elected Officials Representing Northeast Bexar County',
    schemaDescription: 'Elected officials who represent Northeast San Antonio and Bexar County, compiled by the North East Bexar County Democrats.',
    homeHeading:       'Connect With Your Representatives',
    homeButton:        'Find Your Representatives →',
    resourcesHeading:  'Find Your Representatives',
    intro:             orDefault(settings.intro_representatives, 'Your voice matters between elections too. Find out who represents you and how to reach them.'),
  },
};
// Hidden mode keeps the Endorsements wording for anything that still refers to the page.
const pageText = PAGE_TEXT[pageMode] || PAGE_TEXT.endorsements;

// ── Helpers ────────────────────────────────────────────────────────────────

// HTML-escape a string
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Parse a date string like "2026-05-10" into a Date object (local noon to avoid timezone drift)
function parseDate(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

// Format date as "MAY" / "10" for event cards
function formatMonthShort(dateStr) {
  const d = parseDate(dateStr);
  return d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
}
function formatDay(dateStr) {
  return parseDate(dateStr).getDate();
}

// Format date as "May 2026" for grouping headers
function formatMonthYear(dateStr) {
  const d = parseDate(dateStr);
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

// Event type → CSS tag class
const tagClass = {
  'Meeting':  'tag-meeting',
  'Volunteer': 'tag-volunteer',
  'Social':   'tag-social',
  'Election': 'tag-election',
};

// ── Event helpers ──────────────────────────────────────────────────────────

// Upcoming events only (today or later, Central time), sorted by date.
// Past events stay in the CMS but are left off the site automatically.
function upcomingEvents() {
  return events
    .filter(e => e.date && String(e.date).slice(0, 10) >= todayCentral)
    .sort((a, b) => parseDate(a.date) - parseDate(b.date));
}

// Build the homepage event preview cards (up to 3).
// With Mobilize: events marked "Show on Homepage" first, then Mobilize shifts fill the rest.
// Without Mobilize (off-season): events marked "Show on Homepage" first, then the soonest upcoming events.
function buildEventPreviewCards(mobilizeEvents) {
  const upcoming = upcomingEvents();
  const marked = upcoming.filter(e => e.featured);
  const featured = (showMobilize
    ? marked
    : [...marked, ...upcoming.filter(e => !e.featured)]
  ).slice(0, 3).sort((a, b) => parseDate(a.date) - parseDate(b.date));
  const slotsLeft = 3 - featured.length;

  // CMS cards
  const cmsCards = featured.map(e => {
    const url = e.button_url || '#';
    return `
          <div class="event-card">
            <div class="event-date"><span class="event-month">${esc(formatMonthShort(e.date))}</span><span class="event-day">${formatDay(e.date)}</span></div>
            <div class="event-info">
              <h3>${esc(e.title)}</h3>
              <p class="event-meta">${esc(e.time)} · ${esc(e.location)}</p>
              <p>${esc(e.description)}</p>
              <a href="${url === '#' ? 'events.html' : esc(url)}" class="btn-link"${url !== '#' && url.startsWith('http') ? ' target="_blank"' : ''}>RSVP / Learn More →</a>
            </div>
          </div>`;
  });

  // Mobilize fill cards (only if slots remain)
  const mobilizeCards = slotsLeft > 0 && mobilizeEvents && mobilizeEvents.length
    ? mobilizeEvents.slice(0, slotsLeft).map(evt => {
        const now       = Math.floor(Date.now() / 1000);
        const slot      = evt.timeslots && (evt.timeslots.find(s => s.start_date >= now) || evt.timeslots[0]);
        const dateObj   = slot ? new Date(slot.start_date * 1000) : null;
        const monthShort = dateObj
          ? dateObj.toLocaleString('en-US', { month: 'short', timeZone: TIME_ZONE }).toUpperCase()
          : '—';
        const dayNum    = dateObj
          ? dateObj.toLocaleString('en-US', { day: 'numeric', timeZone: TIME_ZONE })
          : '—';
        const timeStr   = dateObj
          ? dateObj.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE })
          : '';
        const location  = evt.location
          ? (evt.location.venue || evt.location.locality || 'See Mobilize for details')
          : (evt.is_virtual ? 'Virtual / Online' : 'See Mobilize for details');

        // Strip HTML tags and truncate to ~150 chars
        const rawDesc   = evt.description ? evt.description.replace(/<[^>]+>/g, '').trim() : '';
        const desc      = rawDesc.length > 150 ? rawDesc.slice(0, 147) + '…' : rawDesc;

        return `
          <div class="event-card">
            <div class="event-date"><span class="event-month">${esc(monthShort)}</span><span class="event-day">${esc(dayNum)}</span></div>
            <div class="event-info">
              <h3>${esc(evt.title)}</h3>
              <p class="event-meta">${timeStr ? esc(timeStr) + ' · ' : ''}${esc(location)}</p>
              ${desc ? `<p>${esc(desc)}</p>` : ''}
              <a href="${esc(evt.browser_url)}" target="_blank" class="btn-link">Sign Up on Mobilize →</a>
            </div>
          </div>`;
      })
    : [];

  const cards = [...cmsCards, ...mobilizeCards];
  if (!cards.length) {
    return `
          <p class="mobilize-intro" style="grid-column:1/-1">No upcoming events are posted right now. Check the full calendar for what's coming up.</p>`;
  }
  return cards.join('\n');
}

// Build the full event list rows grouped by month (events.html)
function buildEventListRows() {
  const upcoming = upcomingEvents();
  if (!upcoming.length) {
    return `
          <p class="mobilize-intro">No upcoming events are posted right now. Check the calendar above, or sign up for a volunteer shift on Mobilize.</p>`;
  }

  const groups = {};
  upcoming.forEach(e => {
    const key = formatMonthYear(e.date);
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  });

  return Object.entries(groups).map(([month, evts]) => {
    const rows = evts.map(e => {
      const isElection = e.type === 'Election';
      const url = e.button_url || '#';
      return `
            <div class="event-row${isElection ? ' event-row--election' : ''}">
              <div class="event-row-date${isElection ? ' event-row-date--red' : ''}"><span class="event-month">${esc(formatMonthShort(e.date))}</span><span class="event-day">${formatDay(e.date)}</span></div>
              <div class="event-row-body">
                <div class="event-row-header">
                  <h4>${esc(e.title)}</h4>
                  <span class="event-tag ${tagClass[e.type] || ''}">${esc(e.type)}</span>
                </div>
                <p class="event-meta">${esc(e.time)} · ${esc(e.location)}</p>
                <p>${esc(e.description)}</p>
                <div class="event-row-actions">
                  <a href="${esc(url)}"${url.startsWith('http') ? ' target="_blank"' : ''} class="btn btn-${isElection ? 'red' : 'blue'} btn-sm">${esc(e.button_label)}</a>
                </div>
              </div>
            </div>`;
    }).join('\n');

    return `
          <div class="event-month-group">
            <h3 class="month-label">${esc(month)}</h3>
            ${rows}
          </div>`;
  }).join('\n');
}

// Build events Schema.org JSON-LD for events.html
function buildEventsSchema() {
  const items = upcomingEvents().map((e, i) => {
    const where = String(e.location || '').trim();
    const isOnline = /\b(zoom|online|virtual)\b/i.test(where);
    return {
      '@type': 'Event',
      position: i + 1,
      name: e.title,
      startDate: e.date,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: isOnline
        ? 'https://schema.org/OnlineEventAttendanceMode'
        : 'https://schema.org/OfflineEventAttendanceMode',
      // Each event's own location, as typed in the CMS (meetings rotate between venues)
      location: isOnline
        ? { '@type': 'VirtualLocation', url: e.button_url }
        : { '@type': 'Place', name: where || 'San Antonio, TX', address: where || 'San Antonio, TX' },
      organizer: {
        '@type': 'Organization',
        name: 'North East Bexar County Democrats',
        url: 'https://www.nebcd.org',
      },
    };
  });

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Upcoming NEBCD Events',
    description: 'Upcoming events from the North East Bexar County Democrats.',
    url: 'https://www.nebcd.org/events',
    itemListElement: items,
  };

  return `<script type="application/ld+json">\n  ${JSON.stringify(schema, null, 2)}\n  <\/script>`;
}

// ── Voting resources ───────────────────────────────────────────────────────
// Representatives mode shows the "Find Your Representatives" links in the same card style.
function buildVotingResourceCards() {
  const list = isRepsMode ? (repsData.lookup_links || []) : (settings.voting_resources || []);
  return list.map(r => `
          <a href="${esc(r.url)}" target="_blank" class="resource-card">
            <div class="resource-icon">${r.icon || ''}</div>
            <h4>${esc(r.title)}</h4>
            <p>${esc(r.description)}</p>
            <span class="btn-link">${esc(r.link_label)}</span>
          </a>`).join('\n');
}

// ── Gallery ────────────────────────────────────────────────────────────────
function buildGalleryPhotos() {
  return (settings.gallery_photos || []).map(p => {
    const sizeClass = p.size === 'tall' ? ' gallery-item--tall' : p.size === 'wide' ? ' gallery-item--wide' : '';
    return `
          <div class="gallery-item${sizeClass}">
            <img src="${esc(p.src)}" alt="${esc(p.alt)}" loading="lazy" />
          </div>`;
  }).join('\n');
}

// ── Endorsement helpers ────────────────────────────────────────────────────

// Homepage election section cards ("Show on Homepage", max 4):
// candidates, or representatives in Representatives mode.
function buildEndorsementPreviewCards() {
  if (isRepsMode) {
    return representatives.filter(r => r.featured).slice(0, 4).map(r => {
      const link = r.website || r.contact_url;
      return `
          <div class="endorsement-card">
            ${r.photo ? `<img src="${esc(r.photo)}" alt="${esc(r.name)}" class="candidate-photo" loading="lazy" />` : ''}
            <div class="candidate-info">
              <h4>${esc(r.name)}</h4>
              <p class="candidate-race">${esc(r.office)}${r.district ? ` — ${esc(r.district)}` : ''}</p>
              ${link ? `<a href="${esc(link)}" class="btn-link" target="_blank">Contact →</a>` : ''}
            </div>
          </div>`;
    }).join('\n');
  }
  const featured = endorsements.filter(e => e.featured).slice(0, 4);
  return featured.map(e => `
          <div class="endorsement-card">
            ${e.photo ? `<img src="${esc(e.photo)}" alt="${esc(e.name)}" class="candidate-photo" loading="lazy" />` : ''}
            <div class="candidate-info">
              <h4>${esc(e.name)}</h4>
              <p class="candidate-race">${esc(e.office)}${e.race_badge ? ` — ${esc(e.race_badge)}` : ''}</p>
              ${e.campaign_url ? `<a href="${esc(e.campaign_url)}" class="btn-link" target="_blank">${esc(e.campaign_url.replace(/^https?:\/\//, ''))} →</a>` : ''}
            </div>
          </div>`).join('\n');
}

// Full candidate card for endorsements.html
function buildCandidateCard(e) {
  const socialLinks = [
    e.facebook_url ? `<a href="${esc(e.facebook_url)}" target="_blank" class="social-icon-link" aria-label="Facebook"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg></a>` : '',
    e.instagram_url ? `<a href="${esc(e.instagram_url)}" target="_blank" class="social-icon-link" aria-label="Instagram"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg></a>` : '',
  ].filter(Boolean).join('\n                    ');

  return `
              <div class="candidate-card">
                ${e.photo ? `<img src="${esc(e.photo)}" alt="${esc(e.name)}" class="candidate-photo" loading="lazy" />` : ''}
                <div class="candidate-card-body">
                  <div class="candidate-card-header">
                    <h4>${esc(e.name)}</h4>
                    ${e.race_badge ? `<span class="race-badge">${esc(e.race_badge)}</span>` : ''}
                  </div>
                  <p class="candidate-race-label">${esc(e.office)}</p>
                  ${e.co_endorsers ? `<p class="candidate-also-endorsed">Also endorsed by: ${esc(e.co_endorsers)}</p>` : ''}
                  <div class="candidate-links">
                    ${e.campaign_url ? `<a href="${esc(e.campaign_url)}" target="_blank" class="btn btn-blue btn-sm">Campaign Site ↗</a>` : ''}
                    ${socialLinks}
                  </div>
                </div>
              </div>`;
}

// Build General Election section grouped by race_group
function buildGeneralSection() {
  const general = endorsements.filter(e => e.election === 'general');
  if (!general.length) return '';

  // Group by race_group
  const groups = {};
  general.forEach(e => {
    const key = e.race_group || e.office;
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  });

  const raceSections = Object.entries(groups).map(([group, candidates]) => `
          <div class="election-race">
            <h3 class="race-label">${esc(group)}</h3>
            <div class="candidate-grid">
              ${candidates.map(buildCandidateCard).join('\n')}
            </div>
          </div>`).join('\n');

  return `
        <div class="election-group" id="general">
          <div class="election-group-header">
            <h2>General Election</h2>
          </div>
          ${raceSections}
        </div>`;
}

// Build Primary section grouped by race_group
function buildPrimarySection() {
  const primary = endorsements.filter(e => e.election === 'primary');
  if (!primary.length) return '';

  // Group by race_group
  const groups = {};
  primary.forEach(e => {
    const key = e.race_group || e.office;
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  });

  const raceSections = Object.entries(groups).map(([group, candidates]) => `
          <div class="election-race">
            <h3 class="race-label">${esc(group)}</h3>
            <div class="candidate-grid">
              ${candidates.map(buildCandidateCard).join('\n')}
            </div>
          </div>`).join('\n');

  return `
        <div class="election-group" id="primary">
          <div class="election-group-header">
            <h2>Primary Election</h2>
          </div>
          ${raceSections}
        </div>`;
}

// Build runoff section
function buildRunoffSection() {
  const runoff = endorsements.filter(e => e.election === 'runoff');
  if (!runoff.length) return '';

  const cards = runoff.map(e => `
            <div class="runoff-card"><h4>${esc(e.name)}</h4><p class="runoff-race">${esc(e.office)}</p></div>`).join('\n');

  return `
        <div class="election-group" id="runoff">
          <div class="election-group-header">
            <h2>Democratic Primary Runoff</h2>
          </div>
          <div class="runoff-grid">
            ${cards}
          </div>
        </div>`;
}

// ── Representatives (Connect With Your Representatives mode) ───────────────

function buildRepresentativeCard(r) {
  const socialLinks = [
    r.facebook_url ? `<a href="${esc(r.facebook_url)}" target="_blank" class="social-icon-link" aria-label="Facebook"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg></a>` : '',
    r.instagram_url ? `<a href="${esc(r.instagram_url)}" target="_blank" class="social-icon-link" aria-label="Instagram"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg></a>` : '',
  ].filter(Boolean).join('\n                    ');

  const phoneDigits = String(r.phone || '').replace(/\D/g, '');
  const contactLine = [
    r.phone ? `<a href="tel:${esc(phoneDigits)}">${esc(r.phone)}</a>` : '',
    r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '',
  ].filter(Boolean).join(' · ');

  return `
              <div class="candidate-card">
                ${r.photo ? `<img src="${esc(r.photo)}" alt="${esc(r.name)}" class="candidate-photo" loading="lazy" />` : ''}
                <div class="candidate-card-body">
                  <div class="candidate-card-header">
                    <h4>${esc(r.name)}</h4>
                    ${r.district ? `<span class="race-badge">${esc(r.district)}</span>` : ''}
                  </div>
                  <p class="candidate-race-label">${esc(r.office)}</p>
                  ${contactLine ? `<p class="candidate-also-endorsed">${contactLine}</p>` : ''}
                  <div class="candidate-links">
                    ${r.contact_url ? `<a href="${esc(r.contact_url)}" target="_blank" class="btn btn-blue btn-sm">Contact ↗</a>` : ''}
                    ${r.website && r.website !== r.contact_url ? `<a href="${esc(r.website)}" target="_blank" class="btn btn-outline btn-sm">Website ↗</a>` : ''}
                    ${socialLinks}
                  </div>
                </div>
              </div>`;
}

// Representatives grouped by their Group heading, in the order groups first appear in the CMS list
function buildRepresentativesSection() {
  if (!representatives.length) {
    return `
        <div class="election-group" id="representatives">
          <p class="mobilize-intro">Representative contact information is coming soon. In the meantime, use the links above to look up who represents you.</p>
        </div>`;
  }

  const groups = {};
  representatives.forEach(r => {
    const key = r.group || r.office;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });

  const groupSections = Object.entries(groups).map(([group, reps]) => `
          <div class="election-race">
            <h3 class="race-label">${esc(group)}</h3>
            <div class="candidate-grid">
              ${reps.map(buildRepresentativeCard).join('\n')}
            </div>
          </div>`).join('\n');

  return `
        <div class="election-group" id="representatives">
          <div class="election-group-header">
            <h2>Who Represents You</h2>
          </div>
          ${groupSections}
        </div>`;
}

// Build the Election page's Schema.org JSON-LD (candidates, or officials in Representatives mode)
function buildEndorsementsSchema() {
  if (isRepsMode) {
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: pageText.schemaName,
      description: pageText.schemaDescription,
      url: 'https://www.nebcd.org/endorsements',
      itemListElement: representatives.map((r, i) => {
        const item = { '@type': 'Person', position: i + 1, name: r.name, jobTitle: `${r.office}${r.district ? `, ${r.district}` : ''}` };
        if (r.website) item.url = r.website;
        if (r.email) item.email = r.email;
        if (r.phone) item.telephone = r.phone;
        return item;
      }),
    };
    return `<script type="application/ld+json">\n  ${JSON.stringify(schema, null, 2)}\n  <\/script>`;
  }

  const items = endorsements.map((e, i) => {
    const item = {
      '@type': 'Person',
      position: i + 1,
      name: e.name,
      description: `${e.office}${e.race_badge ? `, ${e.race_badge}` : ''}`,
    };
    if (e.campaign_url) item.url = e.campaign_url;
    return item;
  });

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: pageText.schemaName,
    description: pageText.schemaDescription,
    url: 'https://www.nebcd.org/endorsements',
    itemListElement: items,
  };

  return `<script type="application/ld+json">\n  ${JSON.stringify(schema, null, 2)}\n  <\/script>`;
}

// ── Template renderer ──────────────────────────────────────────────────────

// Values available on every page: nav, footer, links and office contact info.
const SHARED = {
  NAV_ELECTION_LABEL:    esc(pageText.navLabel),
  CURRENT_YEAR:          currentYear,
  ACTBLUE_DUES_URL:      esc(settings.actblue_dues_url),
  ACTBLUE_DONATE_URL:    esc(settings.actblue_donate_url),
  FACEBOOK_URL:          esc(settings.facebook_url),
  INSTAGRAM_URL:         esc(settings.instagram_url),
  GET_INVOLVED_URL:      esc(getInvolvedUrl),
  MOBILIZE_URL:          esc(mobilizeUrl),
  VOLUNTEER_FORM_ID:     esc(settings.volunteer_form_id),
  OFFICE_ADDRESS_STREET: esc(settings.office_address_street),
  OFFICE_ADDRESS_CITY:   esc(settings.office_address_city),
  OFFICE_PHONE:          esc(settings.office_phone),
  OFFICE_PHONE_HREF:     esc(officePhoneHref),
  OFFICE_EMAIL:          esc(settings.office_email),
  OFFICE_HOURS_LINE1:    esc(settings.office_hours_line1),
  OFFICE_HOURS_LINE2:    esc(settings.office_hours_line2),
  OFFICE_HOURS_LINE3:    esc(settings.office_hours_line3),
  // Store page shows weekday hours on one line
  OFFICE_HOURS_SHORT:    [settings.office_hours_line1, settings.office_hours_line2].filter(Boolean).map(esc).join(' · '),
  OFFICE_DIRECTIONS_URL: esc(settings.office_directions_url),
  SHARE_IMAGE:           esc(shareImage),
};

// On/off flags for the {{#if NAME}} … {{/if NAME}} and {{#unless NAME}} … {{/unless NAME}}
// markers in templates. Marked sections are kept or removed when each page is built.
const FLAGS = {
  IN_SEASON:        inSeason,         // ⚙️ Site Mode → Off-Season Mode is off
  HAS_PHONE:        hasPhone,         // 📍 Office & Contact → Phone is filled in
  ELECTION_PAGE_ON: electionPageOn,   // ⚙️ Site Mode → Election Page Mode isn't Hidden
  SHOW_MOBILIZE:    showMobilize,     // campaign season, or Mobilize kept on in the off-season
  SHOW_LEADERSHIP:  showLeadership,   // 👥 Leadership → Show Leadership is on (and names are listed)
  // Campaign season: a light list under the Mission. Off-season: it takes over the
  // Visit Us spot at the bottom of the homepage (photo + blue panel).
  LEADERSHIP_LIST_ON:    showLeadership && inSeason,
  LEADERSHIP_FEATURE_ON: showLeadership && offSeason,
  HAS_NEWS:         false,            // at least one 📰 News & Statements post is published (set in main below)
};

// Club Leadership list items: name, plus title when one is filled in
function buildLeadershipList() {
  return leaders.map(m => `
          <li><span class="leadership-name">${esc(String(m.name).trim())}</span>${m.title && String(m.title).trim() ? `<span class="leadership-title">${esc(String(m.title).trim())}</span>` : ''}</li>`).join('');
}

// Keep or remove each marked section. Markers on a line of their own are removed with their line;
// markers inside a line are removed in place. Repeats until nested markers are all handled.
function applyConditions(text, flags = FLAGS) {
  const keep = (kind, name) => {
    if (!(name in flags)) throw new Error(`Unknown show/hide marker "${name}" in a template`);
    return kind === 'if' ? !!flags[name] : !flags[name];
  };
  const block  = /^[ \t]*\{\{#(if|unless) ([A-Z_]+)\}\}[ \t]*\r?\n([\s\S]*?)^[ \t]*\{\{\/\1 \2\}\}[ \t]*\r?\n/m;
  const inline = /\{\{#(if|unless) ([A-Z_]+)\}\}([\s\S]*?)\{\{\/\1 \2\}\}/;
  let out = text, m;
  while ((m = out.match(block)) || (m = out.match(inline))) {
    out = out.slice(0, m.index) + (keep(m[1], m[2]) ? m[3] : '') + out.slice(m.index + m[0].length);
  }
  return out;
}

function render(template, replacements = {}) {
  let out = applyConditions(template);
  for (const [key, val] of Object.entries({ ...SHARED, ...replacements })) {
    out = out.split(`{{${key}}}`).join(val == null ? '' : val);
  }
  const leftover = out.match(/{{[#/]?[A-Za-z0-9_ ]+}}/g);
  if (leftover) console.warn(`  ⚠ Unfilled placeholders: ${[...new Set(leftover)].join(', ')}`);
  return out;
}

// Same as render(), for plain-text files like llms.txt (no HTML escaping).
function renderPlain(template, replacements = {}) {
  let out = applyConditions(template);
  for (const [key, val] of Object.entries(replacements)) {
    out = out.split(`{{${key}}}`).join(val == null ? '' : val);
  }
  return out;
}

// ── Site menu ──────────────────────────────────────────────────────────────
// The menu at the top of every page and the "Navigate" links in every footer
// are built from this one list, so they always match. To rename, reorder or add
// a link, change it here (not in the templates).
//   label  = text in the menu        footer = text in the footer, if different
//   home   = link on the homepage    page   = link on every other page
//   show   = whether it appears right now (seasonal switches, published news)
// News appears once at least one post is published (hasNews is set in main below).
let hasNews = false;
const SITE_MENU = {
  election:    { label: pageText.navLabel, page: 'endorsements.html', show: () => electionPageOn },
  events:      { label: 'Events', page: 'events.html' },
  news:        { label: 'News', footer: 'News & Statements', page: 'news/', show: () => hasNews },
  about:       { label: 'About', home: '#mission', page: 'index.html#mission' },
  getInvolved: { label: 'Get Involved', page: getInvolvedUrl, external: true },
  store:       { label: 'Store', page: 'store.html', show: () => inSeason },
  visit:       { label: 'Visit Us', home: '#visit', page: 'index.html#visit', show: () => inSeason },
  leadership:  { label: 'Leadership', home: '#leadership', page: 'index.html#leadership', show: () => offSeason && showLeadership },
};
// Menu order. Election season puts the Election page first; between elections
// the club itself (About) leads. "Join / Donate" is always added last, as the button.
const MENU_ORDER = electionSeason
  ? ['election', 'events', 'news', 'about', 'getInvolved', 'store', 'visit', 'leadership']
  : ['about', 'events', 'news', 'getInvolved', 'election', 'store', 'visit', 'leadership'];

function menuItems() {
  return MENU_ORDER.map(key => SITE_MENU[key]).filter(item => !item.show || item.show());
}
function menuLink(item, isHome, text) {
  const href = (isHome && item.home) || item.page;
  const external = item.external ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a href="${esc(href)}"${external}>${esc(text)}</a>`;
}
function buildNavLinks(isHome) {
  return [
    ...menuItems().map(item => `<li>${menuLink(item, isHome, item.label)}</li>`),
    `<li><a href="${esc(settings.actblue_dues_url)}" target="_blank" class="nav-cta">Join / Donate</a></li>`,
  ].join('\n        ');
}
function buildFooterLinks(isHome) {
  return menuItems().map(item => `<li>${menuLink(item, isHome, item.footer || item.label)}</li>`).join('\n          ');
}

// ── Homepage section order ─────────────────────────────────────────────────
// Each homepage section is marked in index.template.html with
// <!-- [section:name] --> … <!-- [/section] -->, and the build puts them in this
// order. Sections that are switched off are simply skipped. Follows the same
// priorities as the menu above.
const HOME_SECTION_ORDER = electionSeason
  ? ['fundraiser', 'election', 'events', 'mission', 'get-involved', 'gallery', 'leadership-list', 'visit', 'leadership-feature']
  : ['fundraiser', 'mission', 'events', 'get-involved', 'election', 'gallery', 'leadership-list', 'visit', 'leadership-feature'];

function orderHomeSections(html) {
  const marker = /<!-- \[section:([a-z-]+)\] -->\r?\n?([\s\S]*?)[ \t]*<!-- \[\/section\] -->\r?\n?/g;
  const blocks = new Map();
  let first = -1, last = -1, m;
  while ((m = marker.exec(html))) {
    if (first < 0) first = m.index;
    last = m.index + m[0].length;
    blocks.set(m[1], m[2]);
  }
  if (first < 0) return html;
  const unknown = [...blocks.keys()].filter(k => !HOME_SECTION_ORDER.includes(k));
  if (unknown.length) throw new Error(`Homepage section(s) not in HOME_SECTION_ORDER in build.js: ${unknown.join(', ')}`);
  const ordered = HOME_SECTION_ORDER.filter(k => blocks.has(k)).map(k => blocks.get(k).trim()).filter(Boolean);
  return html.slice(0, first) + ordered.join('\n\n    ') + '\n\n' + html.slice(last);
}

// ── Homepage band colors ───────────────────────────────────────────────────
// Every visible homepage section marked "home-band" gets beige / white in turn,
// starting with beige, so two sections next to each other never match.
function alternateBands(html) {
  let n = 0;
  return html.replace(/<section class="([^"]*\bhome-band\b[^"]*)"/g, (m, classes) => {
    const base = classes.split(/\s+/).filter(c => c && c !== 'section-alt');
    if (n++ % 2 === 0) base.push('section-alt');
    return `<section class="${base.join(' ')}"`;
  });
}

// ── Nav label sync ─────────────────────────────────────────────────────────
// Safety net: rewrites the text of plain nav/footer links to endorsements.html
// so every page matches the current mode, even if a template was hand-edited
// with the word typed in. Links with a class (like the homepage "View All…"
// button) are left alone.
const NAV_LINK_PATTERN = /(<a href="endorsements\.html"(?![^>]*\bclass=)[^>]*>)[^<]*(<\/a>)/g;

function syncNavLabel(html) {
  return html.replace(NAV_LINK_PATTERN, `$1${pageText.navLabel}$2`);
}

// ── Mobilize helpers ───────────────────────────────────────────────────────

// Fetch upcoming events from Mobilize public API (no key required)
function fetchMobilizeEvents() {
  return new Promise((resolve) => {
    const url = 'https://api.mobilize.us/v1/organizations/50669/events?timeslot_start=gte_now&per_page=5&visibility=PUBLIC';
    https.get(url, { headers: { 'User-Agent': 'NEBCD-build/1.0' } }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw).data || []);
        } catch {
          console.warn('  ⚠ Could not parse Mobilize API response — skipping section.');
          resolve([]);
        }
      });
    }).on('error', (err) => {
      console.warn(`  ⚠ Mobilize API fetch failed (${err.message}) — skipping section.`);
      resolve([]);
    });
  });
}

// Map Mobilize event_type to NEBCD tag label + CSS class
function mobilizeTagFromTypes(eventType) {
  if (!eventType) return { label: 'Volunteer', cls: 'tag-volunteer' };
  const map = {
    'CANVASS':                    { label: 'Volunteer', cls: 'tag-volunteer' },
    'PHONE_BANK':                 { label: 'Volunteer', cls: 'tag-volunteer' },
    'TEXT_BANK':                  { label: 'Volunteer', cls: 'tag-volunteer' },
    'VOTER_REG':                  { label: 'Volunteer', cls: 'tag-volunteer' },
    'DOOR_KNOCK':                 { label: 'Volunteer', cls: 'tag-volunteer' },
    'COMMUNITY_CANVASS':          { label: 'Volunteer', cls: 'tag-volunteer' },
    'SIGNATURE_GATHERING':        { label: 'Volunteer', cls: 'tag-volunteer' },
    'LETTER_WRITING':             { label: 'Volunteer', cls: 'tag-volunteer' },
    'LITERATURE_DROP_OFF':        { label: 'Volunteer', cls: 'tag-volunteer' },
    'AUTOMATED_PHONE_BANK':       { label: 'Volunteer', cls: 'tag-volunteer' },
    'FRIEND_TO_FRIEND_OUTREACH':  { label: 'Volunteer', cls: 'tag-volunteer' },
    'VOLUNTEER_SHIFT':            { label: 'Volunteer', cls: 'tag-volunteer' },
    'MEETING':                    { label: 'Meeting',   cls: 'tag-meeting'   },
    'TRAINING':                   { label: 'Meeting',   cls: 'tag-meeting'   },
    'TOWN_HALL':                  { label: 'Meeting',   cls: 'tag-meeting'   },
    'WORKSHOP':                   { label: 'Meeting',   cls: 'tag-meeting'   },
    'BARNSTORM':                  { label: 'Meeting',   cls: 'tag-meeting'   },
    'COMMUNITY':                  { label: 'Social',    cls: 'tag-social'    },
    'SOCIAL':                     { label: 'Social',    cls: 'tag-social'    },
    'MEET_GREET':                 { label: 'Social',    cls: 'tag-social'    },
    'HOUSE_PARTY':                { label: 'Social',    cls: 'tag-social'    },
    'FUNDRAISER':                 { label: 'Social',    cls: 'tag-social'    },
    'RALLY':                      { label: 'Social',    cls: 'tag-social'    },
    'DEBATE_WATCH_PARTY':         { label: 'Social',    cls: 'tag-social'    },
    'OFFICE_OPENING':             { label: 'Social',    cls: 'tag-social'    },
    'SOLIDARITY_EVENT':           { label: 'Social',    cls: 'tag-social'    },
    'VISIBILITY_EVENT':           { label: 'Social',    cls: 'tag-social'    },
  };
  return map[eventType] || { label: 'Volunteer', cls: 'tag-volunteer' };
}

// Build the Mobilize events section HTML — reuses existing .event-row markup
function buildMobilizeSection(mobilizeEvents) {
  if (!mobilizeEvents.length) {
    return `
    <section class="mobilize-section">
      <div class="container">
        <h2 class="subsection-title">Volunteer Shifts on Mobilize</h2>
        <p class="mobilize-intro">No upcoming shifts posted yet — check back soon or <a href="${esc(mobilizeUrl)}" target="_blank">visit our Mobilize page</a> directly.</p>
      </div>
    </section>`;
  }

  const rows = mobilizeEvents.slice(0, 5).map(evt => {
    const now        = Math.floor(Date.now() / 1000);
    const slot       = evt.timeslots && (evt.timeslots.find(s => s.start_date >= now) || evt.timeslots[0]);
    const startTs    = slot ? slot.start_date : null;
    const dateObj    = startTs ? new Date(startTs * 1000) : null;
    const monthShort = dateObj
      ? dateObj.toLocaleString('en-US', { month: 'short', timeZone: TIME_ZONE }).toUpperCase()
      : '—';
    const dayNum     = dateObj
      ? dateObj.toLocaleString('en-US', { day: 'numeric', timeZone: TIME_ZONE })
      : '—';
    const timeStr    = dateObj
      ? dateObj.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE })
      : '';
    const extraSlots = evt.timeslots && evt.timeslots.length > 1
      ? ` +${evt.timeslots.length - 1} more time${evt.timeslots.length > 2 ? 's' : ''}`
      : '';
    const location   = evt.location
      ? (evt.location.venue || evt.location.locality || 'See Mobilize for details')
      : (evt.is_virtual ? 'Virtual / Online' : 'See Mobilize for details');

    const tag        = mobilizeTagFromTypes(evt.event_type);

    return `
            <div class="event-row">
              <div class="event-row-date"><span class="event-month">${esc(monthShort)}</span><span class="event-day">${esc(dayNum)}</span></div>
              <div class="event-row-body">
                <div class="event-row-header">
                  <h4>${esc(evt.title)}</h4>
                  <span class="event-tag ${tag.cls}">${tag.label}</span>
                </div>
                <p class="event-meta">${timeStr ? esc(timeStr + extraSlots) + ' · ' : ''}${esc(location)}</p>
                <div class="event-row-actions">
                  <a href="${esc(evt.browser_url)}" target="_blank" class="btn btn-blue btn-sm">Sign Up on Mobilize ↗</a>
                </div>
              </div>
            </div>`;
  }).join('\n');

  return `
    <section class="mobilize-section">
      <div class="container">
        <h2 class="subsection-title">Volunteer Shifts on Mobilize</h2>
        <p class="mobilize-intro">Register directly for phonebanks, canvassing days, and other volunteer opportunities. Spots fill up — sign up early.</p>
        <div class="events-list">
          <div class="event-month-group">
            ${rows}
          </div>
        </div>
        <div class="section-footer-link" style="margin-top:1.5rem">
          <a href="${esc(mobilizeUrl)}" target="_blank" class="btn btn-outline">View All Shifts on Mobilize ↗</a>
        </div>
      </div>
    </section>`;
}

// ── Fundraiser helpers ─────────────────────────────────────────────────────

// Admin-toggled fundraiser callout, shared by the homepage and Events page.
// Returns '' (nothing rendered) when the switch in ⚙️ Site Mode is off.
function buildFundraiserSection() {
  const f = settings.fundraiser;
  if (!f || !f.enabled) return '';

  const photoHtml = f.photo
    ? `<img src="${esc(f.photo)}" alt="${esc(f.photo_alt || f.headline || '')}" class="fundraiser-photo" loading="lazy" />`
    : '';

  return `
    <!-- FUNDRAISER CALLOUT (admin-toggled via CMS: ⚙️ Site Mode → Fundraiser Callout) -->
    <section class="fundraiser-callout home-band" id="fundraiser">
      <div class="container">
        <div class="fundraiser-card">
          ${photoHtml ? `<div class="fundraiser-photo-col">${photoHtml}</div>` : ''}
          <div class="fundraiser-content-col">
            <span class="eyebrow">${esc(f.eyebrow || 'Fundraiser')}</span>
            <h2>${esc(f.headline)}</h2>
            <p>${esc(f.description)}</p>
            ${f.button_url ? `<a href="${esc(f.button_url)}"${f.button_url.startsWith('http') ? ' target="_blank"' : ''} class="btn btn-blue">${esc(f.button_label || 'Learn More →')}</a>` : ''}
          </div>
        </div>
      </div>
    </section>`;
}

// ── News & Statements ──────────────────────────────────────────────────────
// 📰 News & Statements in the admin. Each post is its own file in _data/news/,
// named from the post's title when it's first created (e.g. food-drive.json).
// That file name becomes the post's web address (nebcd.org/news/food-drive) and
// never changes afterwards, so shared links keep working even if the title is edited.
//
// Where posts appear:
//   • Homepage, top photo: a one-line "New statement · Oct 12 — Title →" link,
//     while the newest post is under HERO_LINE_DAYS days old.
//   • Homepage, mission section: the latest post fills the right-hand column
//     (where the two mission photos sit), while it's under LATEST_CARD_DAYS days
//     old or pinned. After that the mission photos come back on their own.
//   • nebcd.org/news: every post, newest first. Each post has its own page.
// Only posts with "Ready to Publish" switched on are shown anywhere on the site.
//
// The age checks run on every build (including the nightly one) and again in the
// visitor's browser, so the homepage stays correct even if a nightly build is missed.
const NEWS_DIR         = '_data/news';
const HERO_LINE_DAYS   = 30;
const LATEST_CARD_DAYS = 90;

const POST_TYPES = {
  Statement:    { cls: 'statement',    heroLabel: 'New statement' },
  News:         { cls: 'news',         heroLabel: 'Latest news' },
  Announcement: { cls: 'announcement', heroLabel: 'Announcement' },
};
const postType = p => (POST_TYPES[p.type] ? p.type : 'News');

// Days from a YYYY-MM-DD date to another (both plain calendar dates)
function daysBetween(fromDate, toDate) {
  const toUTC = d => { const [y, m, day] = String(d).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, day); };
  return Math.round((toUTC(toDate) - toUTC(fromDate)) / 86400000);
}
function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
const formatLongDate  = d => parseDate(d).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const formatShortDate = d => parseDate(d).toLocaleString('en-US', { month: 'short', day: 'numeric' });

// Read every post file. Drafts ("Ready to Publish" off) and posts missing a title
// or date are left off the site, and a note is printed in the build log.
function readPosts() {
  if (!fs.existsSync(NEWS_DIR)) return { published: [], drafts: 0 };
  let drafts = 0;
  const published = [];
  for (const file of fs.readdirSync(NEWS_DIR).filter(f => f.toLowerCase().endsWith('.json')).sort()) {
    let post;
    try {
      post = JSON.parse(fs.readFileSync(`${NEWS_DIR}/${file}`, 'utf8'));
    } catch (err) {
      console.warn(`  ⚠ Skipped news post ${file}: it couldn't be read (${err.message})`);
      continue;
    }
    if (post.published !== true) { drafts++; continue; }
    const date = String(post.date || '').slice(0, 10);
    if (!String(post.title || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.warn(`  ⚠ Skipped news post ${file}: it needs a title and a date`);
      continue;
    }
    const slug = file.replace(/\.json$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    published.push({ ...post, title: String(post.title).trim(), date, slug, type: postType(post) });
  }
  // Newest first; posts on the same day keep a steady order by title
  published.sort((a, b) => (b.date.localeCompare(a.date)) || a.title.localeCompare(b.title));
  return { published, drafts };
}

// ── Markdown → HTML for post bodies ──
// The admin's post editor saves Markdown. This covers everything its toolbar can
// produce: headings, bold, italic, links, images, quotes, bulleted and numbered
// lists (including nested ones), plus line breaks and dividers. Anything typed
// as raw HTML is shown as plain text rather than run as code.

function safeUrl(url) {
  const u = String(url || '').trim();
  return /^(javascript|vbscript|data):/i.test(u) ? '#' : u;
}

function mdInline(text) {
  const stash = [];
  const keep = html => `\u0000${stash.push(html) - 1}\u0000`;
  let s = String(text);
  // Backslash-escaped characters, e.g. \* or \_ (the editor adds these)
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!>~|<])/g, (m, c) => keep(esc(c)));
  s = s.replace(/`([^`]+)`/g, (m, c) => keep(`<code>${esc(c)}</code>`));
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
    (m, alt, src) => keep(`<img src="${esc(safeUrl(src))}" alt="${esc(alt)}" loading="lazy" />`));
  s = s.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, label, href) => {
    const url = safeUrl(href);
    const external = /^https?:/i.test(url);
    return keep(`<a href="${esc(url)}"${external ? ' target="_blank" rel="noopener"' : ''}>${mdInline(label)}</a>`);
  });
  s = s.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g,
    (m, u) => keep(`<a href="${esc(u)}"${/^https?:/i.test(u) ? ' target="_blank" rel="noopener"' : ''}>${esc(u.replace(/^mailto:/i, ''))}</a>`));
  // Plain web addresses typed into the text become links
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'])/g,
    (m, pre, u) => pre + keep(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`));
  s = esc(s);
  s = s.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '<strong><em>$2</em></strong>');
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  s = s.replace(/\*(?=\S)([\s\S]*?\S)\*/g, '<em>$1</em>');
  s = s.replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/(?:\\|[ \t]{2,})\n/g, '<br />\n');
  s = s.replace(/<br \/>\n\s*$/, '');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[Number(i)]);
}

const LIST_ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const indentOf  = line => line.match(/^ */)[0].length;
const isBlockStart = line =>
  /^ {0,3}(#{1,6}[ \t]|>|```|(\*[ \t]*){3,}$|(-[ \t]*){3,}$|(_[ \t]*){3,}$)/.test(line) || LIST_ITEM.test(line);

function mdBlocks(md, headingFloor = 2) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Code block between ``` lines
    if (/^ {0,3}```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^ {0,3}```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading. Post pages already use the title as the main heading, so the
    // largest heading inside a post is shown one level down.
    const h = line.match(/^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/);
    if (h) {
      const level = Math.min(6, Math.max(headingFloor, h[1].length));
      out.push(`<h${level}>${mdInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Divider line
    if (/^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // Quote
    if (/^ {0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && lines[i].trim() && (/^ {0,3}>/.test(lines[i]) || !isBlockStart(lines[i]))) {
        quoted.push(lines[i].replace(/^ {0,3}> ?/, ''));
        i++;
      }
      out.push(`<blockquote>\n${mdBlocks(quoted.join('\n'), headingFloor)}\n</blockquote>`);
      continue;
    }

    // Bulleted or numbered list
    const first = line.match(LIST_ITEM);
    if (first) {
      const base = indentOf(line);
      const ordered = /\d/.test(first[2]);
      const items = [];
      let current = null;
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(LIST_ITEM);
        if (m && indentOf(l) <= base + 1 && /\d/.test(m[2]) === ordered) {
          current = { start: Number.parseInt(m[2], 10), width: indentOf(l) + m[2].length + 1, lines: [m[3]] };
          items.push(current);
          i++;
        } else if (!l.trim()) {
          // A blank line ends the list unless the list carries on after it
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          const next = lines[j];
          const nextItem = next && next.match(LIST_ITEM);
          const continues = next && (indentOf(next) > base + 1 ||
            (nextItem && indentOf(next) <= base + 1 && /\d/.test(nextItem[2]) === ordered));
          if (!continues) break;
          current.lines.push('');
          i++;
        } else if (indentOf(l) > base + 1) {
          current.lines.push(l.slice(Math.min(indentOf(l), current.width)));
          i++;
        } else if (!isBlockStart(l)) {
          current.lines.push(l.trim());   // a wrapped line that belongs to the item
          i++;
        } else {
          break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && items[0].start !== 1 ? ` start="${items[0].start}"` : '';
      const lis = items.map(it => {
        let html = mdBlocks(it.lines.join('\n'), headingFloor);
        // A simple one-paragraph item doesn't need its own paragraph spacing
        html = html.replace(/^<p>([\s\S]*?)<\/p>(?=\n|$)/, '$1');
        return `<li>${html}</li>`;
      }).join('\n');
      out.push(`<${tag}${startAttr}>\n${lis}\n</${tag}>`);
      continue;
    }

    // Paragraph: everything up to the next blank line or new block
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i].replace(/^ +/, ''));
      i++;
    }
    out.push(`<p>${mdInline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

// Plain-text version of a post, for automatic summaries and search previews
function mdToPlainText(md) {
  return String(md || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^ {0,3}```[\s\S]*?^ {0,3}```/gm, ' ')
    .replace(/^ {0,3}#{1,6}[ \t]+.*$/gm, '')              // headings aren't part of the summary
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')                 // links → their text
    .replace(/^ {0,3}(>|[-*+][ \t]|\d+[.)][ \t])[ \t]*/gm, '')
    .replace(/\\([\\`*_{}\[\]()#+\-.!>~|<])/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2')
    .replace(/[ \t]*\\?\n/g, '\n');
}

// Summary shown on the homepage, the News page and in link previews: the post's
// own Summary if one was written, otherwise the opening lines of the post.
function postSummary(post, maxLength = 220) {
  const own = String(post.summary || '').trim();
  if (own) return own;
  const firstPara = mdToPlainText(post.body).split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
  if (firstPara.length <= maxLength) return firstPara;
  const cut = firstPara.slice(0, maxLength);
  return cut.slice(0, cut.lastIndexOf(' ') > 120 ? cut.lastIndexOf(' ') : maxLength).replace(/[\s,;:.!?—–-]+$/, '') + '…';
}

// Pages inside news/ sit one folder down, so their relative links and images
// (style.css, assets/…, events.html…) get a "../" in front.
function relocate(html, prefix = '../') {
  return html.replace(/(\s(?:src|href)=")(?!https?:|mailto:|tel:|data:|#|\/|\.\.\/)([^"]*)"/g, `$1${prefix}$2"`);
}

const postUrl     = p => `news/${p.slug}.html`;                    // link from the site's main folder
const postAddress = p => `https://www.nebcd.org/news/${p.slug}`;   // public address, for sharing and search
const typeBadge   = p => `<span class="post-type post-type--${POST_TYPES[p.type].cls}">${esc(p.type)}</span>`;

// One row in a list of posts (News page and "More from NEBCD")
function buildNewsItem(p, { compact = false } = {}) {
  const summary = postSummary(p);
  return `
          <article class="news-item${compact ? ' news-item--compact' : ''}">
            <div class="news-item-meta">${typeBadge(p)}<time datetime="${p.date}">${esc(formatLongDate(p.date))}</time></div>
            <h${compact ? 3 : 2} class="news-item-title"><a href="${postUrl(p)}">${esc(p.title)}</a></h${compact ? 3 : 2}>
            ${!compact && summary ? `<p>${esc(summary)}</p>` : ''}
            ${compact ? '' : `<a href="${postUrl(p)}" class="btn-link">Read more →</a>`}
          </article>`;
}

// Homepage pieces. Each returns '' when there's nothing to show.
function pickHomepagePosts(posts) {
  const newest = posts[0] || null;
  const heroPost = newest && daysBetween(newest.date, todayCentral) <= HERO_LINE_DAYS ? newest : null;
  const pinned = posts.find(p => p.pinned === true) || null;
  const cardPost = pinned || (newest && daysBetween(newest.date, todayCentral) <= LATEST_CARD_DAYS ? newest : null);
  return { heroPost, cardPost };
}

function buildHeroNewsLine(post) {
  if (!post) return '';
  // data-show-until: the browser hides this line after that date, in case a nightly build is missed
  return `<a href="${postUrl(post)}" class="hero-latest" data-show-until="${addDays(post.date, HERO_LINE_DAYS)}">
          <span class="hero-latest-label">${esc(POST_TYPES[post.type].heroLabel)}</span>
          <span class="hero-latest-date">${esc(formatShortDate(post.date))}</span>
          <span class="hero-latest-title">${esc(post.title)}</span>
          <span class="hero-latest-arrow" aria-hidden="true">→</span>
        </a>`;
}

function buildMissionPhotos(hidden = false) {
  return `<div class="mission-photos" id="mission-photos"${hidden ? ' hidden' : ''}>
            <div class="photo-stack">
              <img src="${esc(missionPhotos[0].src)}" alt="${esc(missionPhotos[0].alt)}" class="photo-main" loading="lazy" />
              <img src="${esc(missionPhotos[1].src)}" alt="${esc(missionPhotos[1].alt)}" class="photo-accent" loading="lazy" />
            </div>
          </div>`;
}

// Right-hand column of the mission section: the latest post, or the mission photos.
function buildMissionSide(post) {
  if (!post) return buildMissionPhotos();
  const summary = postSummary(post);
  // A pinned post stays until it's unpinned. Otherwise the browser swaps the photos
  // back in once the post is LATEST_CARD_DAYS old, even if a nightly build is missed.
  const expires = post.pinned === true ? '' : ` data-show-until="${addDays(post.date, LATEST_CARD_DAYS)}" data-swap-with="mission-photos"`;
  return `<article class="latest-card"${expires}>
            <span class="eyebrow">Latest from NEBCD</span>
            <div class="news-item-meta">${typeBadge(post)}<time datetime="${post.date}">${esc(formatLongDate(post.date))}</time></div>
            <h3 class="latest-card-title"><a href="${postUrl(post)}">${esc(post.title)}</a></h3>
            ${summary ? `<p class="latest-card-summary">${esc(summary)}</p>` : ''}
            <div class="latest-card-actions">
              <a href="${postUrl(post)}" class="btn btn-blue">Read More →</a>
              <a href="news/" class="btn-link">All news &amp; statements →</a>
            </div>
          </article>
          ${expires ? buildMissionPhotos(true) : ''}`;
}

// News & Statements Schema.org data for each post page
function buildPostSchema(post, image) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: post.title,
    description: postSummary(post, 300),
    datePublished: post.date,
    url: postAddress(post),
    mainEntityOfPage: postAddress(post),
    image: [image],
    author: { '@type': 'Organization', name: 'North East Bexar County Democrats', url: 'https://www.nebcd.org' },
    publisher: {
      '@type': 'Organization',
      name: 'North East Bexar County Democrats',
      logo: { '@type': 'ImageObject', url: 'https://www.nebcd.org/assets/NEBCD-Logo-Color.webp' },
    },
  };
  return `<script type="application/ld+json">\n  ${JSON.stringify(schema, null, 2)}\n  <\/script>`;
}

// ── Store helpers ──────────────────────────────────────────────────────────

function buildStoreProductGrid() {
  return (storeData.products || [])
    .filter(p => p.available !== false)
    .map(p => `
          <div class="store-item-card">
            <div class="store-item-img-wrap">
              ${p.photo
                ? `<img src="${esc(p.photo)}" alt="${esc(p.name)}" loading="lazy" />`
                : `<div class="store-item-placeholder-img" aria-hidden="true">🛍️</div>`}
            </div>
            <div class="store-item-info">
              <h3>${esc(p.name)}</h3>
              <p>${esc(p.description)}</p>
            </div>
          </div>`).join('\n');
}

// ── Sponsor helpers ────────────────────────────────────────────────────────

function buildSponsorEvents() {
  return (sponsorData.events || []).map((evt, i) => {
    const isAlt = i % 2 !== 0;
    const detailsHtml = [
      evt.date     ? `<div class="sponsor-detail-item"><span class="detail-label">📅 When</span><span class="detail-value">${esc(evt.date)}</span></div>` : '',
      evt.venue    ? `<div class="sponsor-detail-item"><span class="detail-label">📍 Where</span><span class="detail-value">${esc(evt.venue)}</span></div>` : '',
      evt.attendance ? `<div class="sponsor-detail-item"><span class="detail-label">👥 Attendance</span><span class="detail-value">${esc(evt.attendance)}</span></div>` : '',
    ].filter(Boolean).join('\n');

    const tiersHtml = (evt.tiers || []).map(tier => `
              <div class="sponsor-tier">
                <div class="tier-label">${esc(tier.name)}</div>
                <ul class="tier-perks">
                  ${(tier.perks || []).map(p => `<li>${esc(p)}</li>`).join('\n                  ')}
                </ul>
              </div>`).join('\n');

    const photoHtml = evt.photo
      ? `<div class="sponsor-event-photo"><img src="${esc(evt.photo)}" alt="${esc(evt.name)}" loading="lazy" /></div>`
      : '';

    return `
    <section class="sponsor-event-section${isAlt ? ' section-alt' : ''}" id="${esc(evt.id)}">
      <div class="container">
        <div class="sponsor-event-card">
          ${photoHtml}
          <div class="sponsor-event-header">
            <span class="eyebrow">${esc(evt.eyebrow)}</span>
            <h2>${esc(evt.name)}</h2>
            <p class="sponsor-event-desc">${esc(evt.description)}</p>
          </div>
          ${detailsHtml ? `<div class="sponsor-event-details">${detailsHtml}</div>` : ''}
          <div class="sponsor-tiers">
            <h3>Sponsorship Levels</h3>
            <div class="sponsor-tier-grid">
              ${tiersHtml}
            </div>
          </div>
        </div>
      </div>
    </section>`;
  }).join('\n');
}

// ── Sitemap & llms.txt ─────────────────────────────────────────────────────

// Only pages that are currently switched on are listed for search engines.
function buildSitemap(posts = []) {
  const urls = [
    ['/', 'weekly', '1.0', true],
    ['/events', 'weekly', '0.9', true],
    ['/endorsements', 'monthly', '0.8', electionPageOn],
    ['/news/', 'weekly', '0.7', posts.length > 0],
    ...posts.map(p => [`/news/${p.slug}`, 'monthly', '0.6', true]),
    ['/volunteer', 'monthly', '0.7', true],
    ['/store', 'monthly', '0.6', inSeason],
    ['/sponsor', 'monthly', '0.6', true],
  ].filter(u => u[3]);
  const entries = urls.map(([loc, freq, pri]) => `
  <url>
    <loc>https://www.nebcd.org${loc}</loc>
    <changefreq>${freq}</changefreq>
    <priority>${pri}</priority>
  </url>
`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function buildLlmsTxt() {
  if (!fs.existsSync('llms.template.txt')) return null;
  const pageSummary = {
    endorsements:    "NEBCD's endorsed candidates for the current Bexar County election cycle, plus voting resources (registration/polling lookup).",
    election:        `NEBCD's ${cycle} election guide to the candidates on the Bexar County ballot, plus voting resources (registration/polling lookup).`,
    representatives: 'Connect With Your Representatives — the elected officials who represent Northeast San Antonio and Bexar County, with contact information and lookup tools.',
  }[pageMode] || '';
  const section = {
    endorsements:    ['Endorsements', 'NEBCD endorses candidates in Bexar County local, state, and federal elections each cycle. Endorsed candidates are listed at /endorsements and updated by the organization each election season. For current endorsements, refer to that page rather than this file.'],
    election:        ['Election Guide', `NEBCD publishes a guide to the candidates on the ${cycle} Bexar County ballot at /endorsements. For current information, refer to that page rather than this file.`],
    representatives: ['Representatives', 'Between elections, /endorsements lists the elected officials who represent Northeast San Antonio and Bexar County, with contact details and links to look up representatives by address. For current information, refer to that page rather than this file.'],
  }[pageMode] || ['', ''];
  return renderPlain(fs.readFileSync('llms.template.txt', 'utf8'), {
    OFFICE_ADDRESS_STREET:  settings.office_address_street || '',
    OFFICE_ADDRESS_CITY:    settings.office_address_city || '',
    OFFICE_PHONE:           settings.office_phone || '',
    OFFICE_EMAIL:           settings.office_email || '',
    OFFICE_HOURS_ALL:       [settings.office_hours_line1, settings.office_hours_line2, settings.office_hours_line3].filter(Boolean).join('; '),
    FACEBOOK_URL:           settings.facebook_url || '',
    INSTAGRAM_URL:          settings.instagram_url || '',
    ACTBLUE_DUES_URL:       settings.actblue_dues_url || '',
    ACTBLUE_DONATE_URL:     settings.actblue_donate_url || '',
    MOBILIZE_URL:           mobilizeUrl,
    MEETING_TEXT:           meetingText.replace(/\.$/, ''),
    ELECTION_HOME_SUMMARY:  electionPageOn ? `current ${pageText.navLabel.toLowerCase()} preview, ` : '',
    ELECTION_PAGE_SUMMARY:  pageSummary,
    ELECTION_SECTION_HEADING: section[0],
    ELECTION_SECTION_TEXT:  section[1],
  });
}

// ── Publishing ─────────────────────────────────────────────────────────────
// The finished site is written to _site/, and only _site/ is published.
// Copied in: folders like assets/ and admin/, plus web files in the main folder
// (CSS, JS, images, CNAME, robots.txt, verification files…). Left out: _data/,
// templates, build.js, .github/, and anything starting with "_" or ".".
const SITE_DIR = '_site';
const SKIP_DIRS = new Set(['_data', '_site', 'node_modules']);
const WEB_FILE = /\.(html|css|js|txt|xml|ico|png|jpe?g|webp|gif|svg|webmanifest|pdf|woff2?|ttf|json)$/i;

function isPublishable(name, isDir, generated) {
  if (name.startsWith('.') || name.startsWith('_')) return false;
  if (isDir) return !SKIP_DIRS.has(name);
  if (name === 'CNAME') return true;
  if (/\.template\.(html|txt)$/i.test(name)) return false;
  if (['build.js', 'package.json', 'package-lock.json', 'config.yml'].includes(name)) return false;
  if (generated.has(name)) return false;   // fresh copies are written by the build instead
  return WEB_FILE.test(name);
}

// Safety check before publishing. Missing essentials stop the build (the live site
// stays as it was). Missing images or links are listed as warnings only.
function checkSite(pageFiles) {
  const essentials = [...pageFiles, 'style.css', 'main.js', 'CNAME', 'admin/index.html', 'admin/config.yml'];
  const missingEssentials = essentials.filter(f => !fs.existsSync(`${SITE_DIR}/${f}`));
  if (missingEssentials.length) {
    throw new Error(`Not publishing: the site would be missing ${missingEssentials.join(', ')}`);
  }

  const missing = new Map();
  // Pages in the main folder, plus the News & Statements pages in news/
  const sitePages = [
    ...fs.readdirSync(SITE_DIR).filter(f => f.endsWith('.html')),
    ...(fs.existsSync(`${SITE_DIR}/news`) ? fs.readdirSync(`${SITE_DIR}/news`).filter(f => f.endsWith('.html')).map(f => `news/${f}`) : []),
  ];
  for (const page of sitePages) {
    const html = fs.readFileSync(`${SITE_DIR}/${page}`, 'utf8');
    const folder = path.posix.dirname(page);
    const refs = [
      ...[...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map(m => m[1]),
      ...[...html.matchAll(/content="https:\/\/www\.nebcd\.org\/([^"]+)"/g)].map(m => '/' + m[1]),
    ];
    for (let ref of refs) {
      if (/^(https?:|mailto:|tel:|data:|#|\/\/)/i.test(ref)) continue;
      ref = ref.split(/[?#]/)[0];
      if (!ref) continue;
      // Links starting with "/" are from the main folder; others are from the page's own folder
      ref = ref.startsWith('/') ? ref.replace(/^\/+/, '') : path.posix.normalize(path.posix.join(folder, ref));
      if (!ref || ref === '.') continue;
      if (!/\.[a-z0-9]+$/i.test(ref)) continue;   // extensionless page addresses like "events"
      if (!fs.existsSync(`${SITE_DIR}/${decodeURIComponent(ref)}`)) {
        if (!missing.has(ref)) missing.set(ref, new Set());
        missing.get(ref).add(page);
      }
    }
  }
  if (missing.size) {
    console.warn(`  ⚠ ${missing.size} file(s) referenced but not found (site still published):`);
    for (const [ref, pages] of missing) console.warn(`     - ${ref}  (on ${[...pages].join(', ')})`);
  } else {
    console.log('  ✓ Every image, stylesheet, script and page link checked out');
  }
}

// ── Main (async to support Mobilize API fetch) ─────────────────────────────
async function main() {

const modeName = { endorsements: 'Endorsements', election: 'Election Guide', representatives: 'Connect With Your Representatives', hidden: 'Hidden' }[pageMode];
console.log(`Today (Central): ${todayCentral}`);
console.log(`Settings read from: ${foundSettingsFiles.join(', ')}`);
console.log(`Season: ${inSeason ? 'Campaign season (office, store and Mobilize shown)' : 'Off-season (office, store and Mobilize hidden)'}`);
console.log(`Election page mode: ${modeName}`);
console.log(`Mobilize: ${showMobilize ? 'shown' : 'hidden'} | Club Leadership: ${showLeadership ? `shown (${leaders.length} names)` : 'hidden'}`);

let mobilizeEvents = [];
if (showMobilize) {
  console.log('Fetching Mobilize events...');
  mobilizeEvents = await fetchMobilizeEvents();
  console.log(`  ✓ ${mobilizeEvents.length} Mobilize event(s) fetched`);
}

// 📰 News & Statements
const { published: posts, drafts } = readPosts();
const { heroPost, cardPost } = pickHomepagePosts(posts);
FLAGS.HAS_NEWS = hasNews = posts.length > 0;
// Menu and footer links, now that it's known whether News has any posts.
// The homepage uses its own in-page links (#mission); other pages link back to it.
SHARED.NAV_LINKS    = buildNavLinks(false);
SHARED.FOOTER_LINKS = buildFooterLinks(false);
console.log(`Menu (${electionSeason ? 'election season' : 'between elections'}): ${menuItems().map(i => i.label).join(' · ')} · Join / Donate`);
console.log(`News & Statements: ${posts.length} published, ${drafts} not ready to publish yet`);
console.log(`  Homepage top line: ${heroPost ? `"${heroPost.title}"` : `none (no post in the last ${HERO_LINE_DAYS} days)`}`);
console.log(`  Homepage mission column: ${cardPost ? `"${cardPost.title}"${cardPost.pinned === true ? ' (pinned)' : ''}` : 'mission photos'}`);

// Short "closed for now" page shown at the address of a section that's switched off,
// so old links and QR codes don't hit an error. Kept out of search results.
const notice = (title, eyebrow, heading, text) => ({
  template: 'notice',
  values: () => ({ NOTICE_TITLE: esc(title), NOTICE_EYEBROW: esc(eyebrow), NOTICE_HEADING: esc(heading), NOTICE_TEXT: esc(text) }),
});

// Each page: template file → output file, plus that page's own values.
// Shared values (nav, footer, links, office info) are filled in automatically.
const pages = [
  {
    file: 'index',
    values: () => ({
      HERO_IMAGE:                settings.hero_image,
      HERO_IMAGE_ALT:            esc(settings.hero_image_alt),
      VISIT_PHOTO:               settings.visit_photo,
      VISIT_PHOTO_ALT:           esc(settings.visit_photo_alt),
      VISIT_DESCRIPTION:         esc(settings.visit_description),
      MEETING_TEXT:              esc(meetingText),
      MISSION_PHOTO_1:           esc(missionPhotos[0].src),
      MISSION_PHOTO_1_ALT:       esc(missionPhotos[0].alt),
      MISSION_PHOTO_2:           esc(missionPhotos[1].src),
      MISSION_PHOTO_2_ALT:       esc(missionPhotos[1].alt),
      LEADERSHIP_INTRO:          esc(orDefault(leadershipData.intro, 'The volunteers who lead NEBCD and keep the club running.')),
      LEADERSHIP_LIST:           buildLeadershipList(),
      LEADERSHIP_PHOTO:          esc(assetPath(orDefault(leadershipData.photo, 'assets/nebcd-key-court.webp'))),
      LEADERSHIP_PHOTO_ALT:      esc(orDefault(leadershipData.photo_alt, 'NEBCD members together at the Bexar County Courthouse')),
      ENDORSEMENTS_INTRO:        esc(pageText.intro),
      HOME_ENDORSEMENTS_HEADING: esc(pageText.homeHeading),
      HOME_ENDORSEMENTS_BUTTON:  esc(pageText.homeButton),
      EVENT_PREVIEW_CARDS:       buildEventPreviewCards(mobilizeEvents),
      ENDORSEMENT_PREVIEW_CARDS: buildEndorsementPreviewCards(),
      GALLERY_PHOTOS:            buildGalleryPhotos(),
      FUNDRAISER_SECTION:        buildFundraiserSection(),
      HERO_NEWS_LINE:            buildHeroNewsLine(heroPost),
      MISSION_SIDE:              buildMissionSide(cardPost),
      NAV_LINKS:                 buildNavLinks(true),
      FOOTER_LINKS:              buildFooterLinks(true),
      // Small label over the homepage's election section
      HOME_ELECTION_EYEBROW:     esc(isRepsMode ? pageText.eyebrow : 'Know Before You Vote'),
      // Main button over the top photo: the Election page during election season,
      // otherwise the office (campaign season) or upcoming events (off-season).
      HERO_PRIMARY_BUTTON:       electionSeason
        ? `<a href="endorsements.html" class="btn btn-primary">${esc(pageText.heroButton)}</a>`
        : inSeason
          ? '<a href="#visit" class="btn btn-primary">Visit Our Office</a>'
          : '<a href="events.html" class="btn btn-primary">See Upcoming Events</a>',
      // When the latest-post card isn't showing, a small link still leads to past posts
      MISSION_NEWS_LINK:         posts.length && !cardPost
        ? '<p class="mission-news-link"><a href="news/" class="btn-link">Read our news &amp; statements →</a></p>'
        : '',
    }),
  },
  {
    file: 'events',
    values: () => ({
      EVENT_LIST_ROWS:    buildEventListRows(),
      EVENTS_SCHEMA:      buildEventsSchema(),
      MOBILIZE_SECTION:   showMobilize ? buildMobilizeSection(mobilizeEvents) : '',
      FUNDRAISER_SECTION: buildFundraiserSection(),
    }),
  },
  electionPageOn ? {
    file: 'endorsements',
    values: () => ({
      ENDORSEMENTS_CYCLE_LABEL: esc(cycle),
      ENDORSEMENTS_INTRO:       esc(pageText.intro),
      PAGE_TITLE:               esc(pageText.title),
      PAGE_DESCRIPTION:         esc(pageText.description),
      PAGE_KEYWORDS:            esc(pageText.keywords),
      SOCIAL_TITLE:             esc(pageText.socialTitle),
      SOCIAL_DESCRIPTION:       esc(pageText.socialDescription),
      BREADCRUMB_LABEL:         esc(pageText.breadcrumb),
      PAGE_EYEBROW:             esc(pageText.eyebrow),
      PAGE_HEADING:             esc(pageText.heading),
      RESOURCES_HEADING:        esc(pageText.resourcesHeading),
      VOTING_RESOURCE_CARDS:    buildVotingResourceCards(),
      GENERAL_SECTION:          isRepsMode ? buildRepresentativesSection() : buildGeneralSection(),
      PRIMARY_SECTION:          isRepsMode ? '' : buildPrimarySection(),
      RUNOFF_SECTION:           isRepsMode ? '' : buildRunoffSection(),
      ENDORSEMENTS_SCHEMA:      buildEndorsementsSchema(),
    }),
  } : {
    file: 'endorsements',
    ...notice('Election Guide', 'Between Elections', 'Our Election Guide Will Return',
      "NEBCD's endorsements and election guide come back before the next election. Until then, find us at an upcoming meeting or event."),
  },
  inSeason ? {
    file: 'store',
    values: () => ({
      STORE_INTRO:        esc(storeData.store_intro),
      STORE_PRODUCT_GRID: buildStoreProductGrid(),
    }),
  } : {
    file: 'store',
    ...notice('Store', 'NEBCD Store', 'The Store Is Closed for Now',
      'The NEBCD store reopens next election season. Until then, look for us at upcoming meetings and events.'),
  },
  {
    file: 'sponsor',
    values: () => ({
      SPONSOR_INTRO:  esc(sponsorData.sponsor_intro),
      SPONSOR_EVENTS: buildSponsorEvents(),
    }),
  },
  { file: 'volunteer', values: () => ({}) },
  { file: 'privacy',   values: () => ({}) },
  { file: 'terms',     values: () => ({}) },
];

const pageFiles = pages.map(p => `${p.file}.html`);
const generated = new Set([...pageFiles, 'sitemap.xml', 'llms.txt']);

// Start a fresh _site/ folder and copy in everything the site needs
fs.rmSync(SITE_DIR, { recursive: true, force: true });
fs.mkdirSync(SITE_DIR);
const skipped = [];
for (const entry of fs.readdirSync('.', { withFileTypes: true })) {
  if (isPublishable(entry.name, entry.isDirectory(), generated)) {
    fs.cpSync(entry.name, `${SITE_DIR}/${entry.name}`, { recursive: true });
  } else if (!entry.name.startsWith('.') && entry.name !== SITE_DIR) {
    skipped.push(entry.name + (entry.isDirectory() ? '/' : ''));
  }
}
console.log(`Not published (working files): ${skipped.join(', ') || 'none'}`);

for (const page of pages) {
  const templatePath = `${page.template || page.file}.template.html`;
  const outputPath   = `${page.file}.html`;

  if (fs.existsSync(templatePath)) {
    console.log(`Building ${outputPath}${page.template ? ' (closed-for-now notice)' : ''}...`);
    let html = render(fs.readFileSync(templatePath, 'utf8'), page.values());
    if (page.file === 'index') html = alternateBands(orderHomeSections(html));
    fs.writeFileSync(`${SITE_DIR}/${outputPath}`, syncNavLabel(html));
    console.log(`  ✓ ${outputPath}`);
  } else if (fs.existsSync(outputPath)) {
    // No template yet: publish the existing page, just matching the nav label.
    fs.writeFileSync(`${SITE_DIR}/${outputPath}`, syncNavLabel(fs.readFileSync(outputPath, 'utf8')));
    console.log(`  ✓ ${outputPath} (no ${templatePath} found, nav label synced only)`);
  } else {
    console.warn(`  ⚠ Skipped ${page.file}: no ${templatePath} found`);
  }
}

// 📰 News & Statements pages: nebcd.org/news (all posts) and nebcd.org/news/<post>.
// Nothing is built until at least one post is published.
const newsFiles = [];
if (posts.length) {
  fs.mkdirSync(`${SITE_DIR}/news`, { recursive: true });

  console.log('Building news/index.html...');
  const listHtml = render(fs.readFileSync('news.template.html', 'utf8'), {
    NEWS_LIST: posts.map(p => buildNewsItem(p)).join('\n'),
  });
  fs.writeFileSync(`${SITE_DIR}/news/index.html`, relocate(syncNavLabel(listHtml)));
  newsFiles.push('news/index.html');

  const postTemplate = fs.readFileSync('post.template.html', 'utf8');
  for (const p of posts) {
    const photo = assetPath(p.photo);
    const image = `https://www.nebcd.org/${photo || shareImage}`;
    const others = posts.filter(o => o !== p).slice(0, 3);
    const html = render(postTemplate, {
      POST_TITLE:       esc(p.title),
      POST_DESCRIPTION: esc(postSummary(p, 300)),
      POST_ADDRESS:     esc(postAddress(p)),
      POST_IMAGE:       esc(image),
      POST_TYPE:        esc(p.type),
      POST_TYPE_CLASS:  POST_TYPES[p.type].cls,
      POST_DATE:        p.date,
      POST_DATE_LONG:   esc(formatLongDate(p.date)),
      POST_PHOTO:       photo
        ? `<figure class="post-photo"><img src="${esc(photo)}" alt="${esc(p.photo_alt || '')}" /></figure>`
        : '',
      POST_MORE:        others.length
        ? `<aside class="post-more">
          <h2 class="post-more-heading">More from NEBCD</h2>
          ${others.map(o => buildNewsItem(o, { compact: true })).join('\n')}
          <a href="news/" class="btn btn-outline">All News &amp; Statements →</a>
        </aside>`
        : `<aside class="post-more"><a href="news/" class="btn btn-outline">All News &amp; Statements →</a></aside>`,
      POST_SCHEMA:      buildPostSchema(p, image),
      // The post's own text goes in last, so nothing typed in it is mistaken for a placeholder
      POST_BODY:        mdBlocks(p.body),
    });
    fs.writeFileSync(`${SITE_DIR}/news/${p.slug}.html`, relocate(syncNavLabel(html)));
    newsFiles.push(`news/${p.slug}.html`);
  }
  console.log(`  ✓ news/index.html and ${posts.length} post page(s)`);
}

fs.writeFileSync(`${SITE_DIR}/sitemap.xml`, buildSitemap(posts));
console.log('  ✓ sitemap.xml');
const llms = buildLlmsTxt();
if (llms !== null) {
  fs.writeFileSync(`${SITE_DIR}/llms.txt`, llms);
  console.log('  ✓ llms.txt');
} else if (fs.existsSync('llms.txt')) {
  fs.copyFileSync('llms.txt', `${SITE_DIR}/llms.txt`);
}

console.log('Checking the finished site...');
checkSite([...pageFiles, ...newsFiles]);

console.log('\nBuild complete. Publishing the _site folder.');

} // end main()

main().catch(err => { console.error('Build failed:', err); process.exit(1); });
