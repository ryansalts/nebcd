/* ════════════════════════════════
   NEBCD — main.js
════════════════════════════════ */

// ── Nav: scroll shadow ──
const header = document.getElementById('site-header');
window.addEventListener('scroll', () => {
  header.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

// ── Nav: mobile toggle ──
const toggle   = document.getElementById('nav-toggle');
const navLinks = document.getElementById('nav-links');

toggle.addEventListener('click', () => {
  const isOpen = navLinks.classList.toggle('open');
  toggle.classList.toggle('open', isOpen);
  toggle.setAttribute('aria-expanded', isOpen);
});

// Close mobile nav on link click
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
    toggle.classList.remove('open');
  });
});

// Close on outside click
document.addEventListener('click', (e) => {
  if (!header.contains(e.target)) {
    navLinks.classList.remove('open');
    toggle.classList.remove('open');
  }
});

// ── Nav: active link on scroll ──
const sections = document.querySelectorAll('section[id]');
const navItems = document.querySelectorAll('.nav-links a[href^="#"]');

const sectionObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navItems.forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === '#' + entry.target.id);
      });
    }
  });
}, { rootMargin: '-40% 0px -55% 0px' });

sections.forEach(s => sectionObserver.observe(s));

// ── Scroll-in fade animations ──
const fadeTargets = document.querySelectorAll(
  '.event-card, .endorsement-card, .involve-card, .endorsement-list-item'
);

const fadeObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
      fadeObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.08 });

fadeTargets.forEach((el, i) => {
  el.style.opacity  = '0';
  el.style.transform = 'translateY(18px)';
  el.style.transition = `opacity 0.5s ease ${i * 0.07}s, transform 0.5s ease ${i * 0.07}s`;
  fadeObserver.observe(el);
});

// ── Mission section fade-in ──
const missionGrid = document.querySelector('.mission-grid');
if (missionGrid) {
  missionGrid.style.opacity  = '0';
  missionGrid.style.transform = 'translateY(24px)';
  missionGrid.style.transition = 'opacity 0.6s ease, transform 0.6s ease';

  const missionObs = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      missionGrid.style.opacity  = '1';
      missionGrid.style.transform = 'translateY(0)';
      missionObs.disconnect();
    }
  }, { threshold: 0.1 });
  missionObs.observe(missionGrid);
}
