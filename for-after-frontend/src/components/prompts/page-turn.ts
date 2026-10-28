/*
 * A book-like page turn for the My Story reader (2026-10-21). Plain DOM and
 * the Web Animations API, no dependency: chapters have any height, which a
 * fixed-size page-flip library cannot hold. The live chapter always stays
 * real, accessible HTML; only a copy of the outgoing page's visible slice is
 * made for the turn, inside an inert, aria-hidden layer.
 *
 * Next: the current page lifts from its right edge and turns away to the
 * left, revealing the next chapter. Previous: the earlier page turns back in
 * from the left and settles over the current one.
 */

export const TURN_MS = 760;
const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const DEPTH = 'perspective(2200px)';
const EDGE_ON = 'rotateY(-92deg)';

export type TurnMode = 'turn' | 'fade' | 'none';
export type Snapshot = { layer: HTMLElement; sheet: HTMLElement; fold: HTMLElement; shade: HTMLElement; height: number };

/** The 3D turn when the browser can animate and the reader has not asked for less motion. */
export function turnMode(page: HTMLElement): TurnMode {
  if (typeof page.animate !== 'function') return 'none';
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'fade' : 'turn';
}

const box = (style: Partial<CSSStyleDeclaration>) => {
  const el = document.createElement('div');
  Object.assign(el.style, { position: 'absolute', left: '0', right: '0', top: '0', ...style });
  return el;
};

/**
 * Copies what the reader can see of `page` into `layer`. Call it while the
 * outgoing chapter is still rendered. Deep in a long chapter, the window is
 * scrolled so the page starts where that slice was: the next chapter then
 * opens at its top, under the turning sheet.
 */
export function snapshot(page: HTMLElement, layer: HTMLElement): Snapshot {
  const inset = document.querySelector('[data-topbar]')?.getBoundingClientRect().bottom ?? 0;
  const rect = page.getBoundingClientRect();
  const top = Math.max(rect.top, inset);
  const sliceTop = top - rect.top;
  const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - top);
  if (sliceTop > 0) window.scrollTo({ top: window.scrollY - sliceTop, behavior: 'instant' });

  const copy = page.cloneNode(true) as HTMLElement;
  // No duplicate ids, and no media that could load or play behind the sheet.
  for (const el of [copy, ...copy.querySelectorAll('[id]')]) el.removeAttribute('id');
  for (const media of copy.querySelectorAll('video, audio')) {
    media.removeAttribute('autoplay');
    media.removeAttribute('src');
  }
  Object.assign(copy.style, { position: 'absolute', top: `${-sliceTop}px`, left: '0', width: `${rect.width}px`, margin: '0' });

  const sheet = box({ height: `${height}px`, overflow: 'hidden', background: 'var(--background)', backfaceVisibility: 'hidden', transformOrigin: '0 50%' });
  // The fold: a soft shadow gathering at the lifted edge.
  const fold = box({ bottom: '0', opacity: '0', background: 'linear-gradient(to left, rgb(0 0 0 / 0.16), rgb(0 0 0 / 0) 40%)' });
  sheet.append(copy, fold);
  // The shadow the turning page casts: darkest at the spine, no hard edges.
  const shade = box({
    height: `${height}px`,
    opacity: '0',
    background: 'linear-gradient(to right, rgb(0 0 0 / 0.5), rgb(0 0 0 / 0) 75%)',
    maskImage: 'linear-gradient(to bottom, black 70%, transparent)',
  });

  layer.setAttribute('aria-hidden', 'true');
  layer.setAttribute('inert', '');
  return { layer, sheet, fold, shade, height };
}

/** Plays the turn; always cleans up, whether it finishes, fails or is cancelled. */
export function playTurn(page: HTMLElement, snap: Snapshot, dir: 'next' | 'prev') {
  const timing: KeyframeAnimationOptions = { duration: TURN_MS, easing: EASE, fill: 'forwards' };
  const { layer, sheet, fold, shade, height } = snap;
  const animations: Animation[] = [];
  if (dir === 'next') {
    // Outgoing sheet above the next chapter, turning away to the left.
    layer.style.zIndex = '2';
    layer.replaceChildren(shade, sheet);
    animations.push(
      sheet.animate([{ transform: `${DEPTH} rotateY(0deg)` }, { transform: `${DEPTH} ${EDGE_ON}` }], timing),
      fold.animate([{ opacity: 0 }, { opacity: 1 }], timing),
      shade.animate([{ opacity: 0.3 }, { opacity: 0 }], timing),
    );
  } else {
    // The outgoing page stays put underneath; the earlier chapter turns in over it.
    layer.style.zIndex = '0';
    layer.replaceChildren(sheet, shade);
    Object.assign(page.style, { zIndex: '1', background: 'var(--background)', backfaceVisibility: 'hidden', transformOrigin: `0 ${height / 2}px` });
    animations.push(
      page.animate([{ transform: `${DEPTH} ${EDGE_ON}` }, { transform: `${DEPTH} rotateY(0deg)` }], timing),
      shade.animate([{ opacity: 0 }, { opacity: 0.3 }], timing),
    );
  }
  const cleanup = () => {
    for (const a of animations) a.cancel();
    for (const prop of ['z-index', 'background', 'backface-visibility', 'transform-origin']) page.style.removeProperty(prop);
    layer.replaceChildren();
    layer.style.removeProperty('z-index');
  };
  const finished = Promise.all(animations.map((a) => a.finished)).then(
    () => cleanup(),
    (err: unknown) => {
      cleanup();
      throw err;
    },
  );
  return { finished, cancel: cleanup };
}
