/**
 * A first-run walkthrough: a dimmed page with one element spotlit and a card
 * explaining it.
 *
 * The overlay is deliberately `pointer-events-none` apart from its own card, so
 * the page stays usable while the tour is open — the connect step exists to be
 * acted on, and a tour that traps you is worse than no tour.
 */

export type TourId = "intro" | "features";

type Step = {
  /** Element to spotlight. Omitted for a centred card with no anchor. */
  target?: string;
  title: string;
  body: string;
};

const SEEN_PREFIX = "sushiflush:tour:";

const TOURS: Record<TourId, Step[]> = {
  intro: [
    {
      title: "Welcome to SushiFlush",
      body: "Stake SFLUSH and earn more SFLUSH. This runs on the Sepolia test network, so the tokens carry no real value — it is a place to try staking safely.",
    },
    {
      target: "wallet-connect",
      title: "Connect a wallet",
      body: "Pick your wallet here. It will ask you to approve the connection. The site only ever sees your address — never your keys or seed phrase.",
    },
    {
      title: "You will need two things",
      body: "Some Sepolia ETH to pay gas, and some SFLUSH to stake. Both are free from Sepolia faucets. You can read the pool numbers below without connecting at all.",
    },
  ],
  features: [
    {
      target: "position-panel",
      title: "Where your tokens are",
      body: "In wallet is what you can stake, Staked is what is earning, and Claimable is what you have earned. Claimable ticks upward every second.",
    },
    {
      target: "action-form",
      title: "Stake or withdraw",
      body: "Switch tabs, type an amount, and MAX fills the largest one you can use. The line above the field shows what you would be left with.",
    },
    {
      target: "preview-panel",
      title: "See it before you sign",
      body: "As you type, this shows your stake, pool share and daily rewards before and after — so nothing about the transaction is a surprise.",
    },
    {
      target: "reward-claim",
      title: "Taking your rewards",
      body: "Claim collects rewards and leaves your stake working. Withdraw all & claim unwinds the whole position, so it asks you to confirm a second time first.",
    },
    {
      target: "pool-panel",
      title: "Pool numbers",
      body: "How fast rewards are emitted, and what that annualises to at the current pool size. The rate falls as more people stake, because one stream is shared.",
    },
    {
      target: "activity-panel",
      title: "Your history",
      body: "Every stake, withdrawal and claim you have made, read back from chain events. That is the whole tour — reopen it any time with Guide, up top.",
    },
  ],
};

let steps: Step[] = [];
let index = 0;
let active: TourId | null = null;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function isTourSeen(id: TourId): boolean {
  try {
    return localStorage.getItem(`${SEEN_PREFIX}${id}`) === "done";
  } catch {
    // Private windows can throw on access; a tour that reappears is a far
    // smaller problem than one that breaks the page.
    return false;
  }
}

function markSeen(id: TourId) {
  try {
    localStorage.setItem(`${SEEN_PREFIX}${id}`, "done");
  } catch {
    /* Nothing to do — the tour simply offers itself again next visit. */
  }
}

export function startTour(id: TourId) {
  active = id;
  steps = TOURS[id];
  index = 0;

  el("tour").hidden = false;
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, { passive: true });
  render();
}

export function endTour() {
  if (active === null) return;
  markSeen(active);
  active = null;

  el("tour").hidden = true;
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", position);
  window.removeEventListener("scroll", position);
}

/** Closes without recording completion — used when the context changes. */
export function abandonTour() {
  if (active === null) return;
  active = null;
  el("tour").hidden = true;
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", position);
  window.removeEventListener("scroll", position);
}

export function isTourActive(): boolean {
  return active !== null;
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") endTour();
  else if (event.key === "ArrowRight" || event.key === "Enter") next();
  else if (event.key === "ArrowLeft") back();
}

function next() {
  if (index >= steps.length - 1) {
    endTour();
    return;
  }
  index += 1;
  render();
}

function back() {
  if (index === 0) return;
  index -= 1;
  render();
}

function render() {
  const step = steps[index];
  if (!step) return;

  el("tour-step").textContent = `Step ${index + 1} of ${steps.length}`;
  el("tour-title").textContent = step.title;
  el("tour-body").textContent = step.body;

  el<HTMLButtonElement>("tour-back").disabled = index === 0;
  el("tour-next").textContent = index === steps.length - 1 ? "Done" : "Next";

  const target = step.target ? document.getElementById(step.target) : null;
  // Bring the subject into view before measuring, or the spotlight lands on
  // wherever it used to be.
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  window.setTimeout(position, target ? 260 : 0);
  position();
}

const MARGIN = 8;
const GAP = 12;

function position() {
  const step = steps[index];
  if (!step) return;

  const spot = el("tour-spot");
  const card = el("tour-card");
  const target = step.target ? document.getElementById(step.target) : null;

  if (!target) {
    // No anchor: dim everything and centre the card.
    spot.style.cssText = "inset:0;border-radius:0";
    card.style.left = `${Math.max(MARGIN, (window.innerWidth - card.offsetWidth) / 2)}px`;
    card.style.top = `${Math.max(MARGIN, (window.innerHeight - card.offsetHeight) / 2)}px`;
    return;
  }

  const rect = target.getBoundingClientRect();
  spot.style.cssText = [
    `left:${rect.left - MARGIN}px`,
    `top:${rect.top - MARGIN}px`,
    `width:${rect.width + MARGIN * 2}px`,
    `height:${rect.height + MARGIN * 2}px`,
    "border-radius:0.75rem",
  ].join(";");

  // Below the target when there is room, otherwise above it.
  const below = rect.bottom + GAP;
  const fits = below + card.offsetHeight + MARGIN <= window.innerHeight;
  const top = fits ? below : Math.max(MARGIN, rect.top - GAP - card.offsetHeight);

  const left = Math.min(
    Math.max(MARGIN, rect.left),
    Math.max(MARGIN, window.innerWidth - card.offsetWidth - MARGIN),
  );

  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
}

export function bindTour() {
  el("tour-next").addEventListener("click", next);
  el("tour-back").addEventListener("click", back);
  el("tour-skip").addEventListener("click", endTour);
}
