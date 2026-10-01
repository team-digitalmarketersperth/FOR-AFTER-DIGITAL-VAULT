# 🎨 For After — Frontend Design System

> The visual source of truth for the Next.js app (Step 17 refinement onward). The app is the private, signed-in part of
> the WordPress marketing site, so every value here starts from that site. Tokens live in one file:
> [`src/app/globals.css`](../src/app/globals.css).

| | |
|---|---|
| **Design source** | Live WordPress site `https://for-after.digitalmarketersperth.com.au/` (Elementor v4 + Blocksy theme) |
| **Audited** | 2026-09-30: Home, About, Features, How It Works, Pricing, Contact (desktop 1440 px + mobile 390 px) |
| **Method** | Playwright read the site's CSS variables, computed styles and `document.fonts`; logo/photos downloaded from `/wp-content/uploads/2026/09/` |
| **Labels** | **Verified** = read from the live site. **Inferred** = not on the site; chosen to fit it and safe to replace |

---

## 1. Colour

### Brand palette (verified)

| Token | Value | Site variable | Used for on the site |
|---|---|---|---|
| `--brand-aubergine` | `#483a4f` | `--Aubergine` / palette 2 | Dark CTAs, the aubergine section band, button text on petal |
| `--brand-semi-black` | `#2b2230` | `--Semi-Black` / palette 4 | Body text |
| `--brand-petal` | `#f3ecef` | `--Petal` / palette 5 | Light CTAs, blush section backgrounds, text on aubergine |
| `--brand-lilac` | `#c0aec8` | `--Lilac` | Accent |
| `--brand-lilac-grey` | `#dbd6de` | computed section background | "How it works" band |
| `--brand-bronze` | `#9a8067` | `--Antique-Bronze` / palette 3 | Accent |
| `--brand-gold` | `#b0803c` | palette 1 (variable named `--Soft-Plum`) | Logo full stop, social icons |
| `--brand-off-white` | `#fafbfc` | palette 7, computed `body` background | Page background |
| `--brand-hairline` | `rgb(90 92 84 / .14)` | `--Line-ThinDark` | Input and card lines |
| white | `#ffffff` | palette 8 | Surfaces |

The site has **no burgundy/maroon** (e.g. `#632F3B` was not found). Its accent is aubergine.

### Semantic tokens (what components use)

| Token | Value | Status |
|---|---|---|
| `--background` | brand off-white `#fafbfc` | verified |
| `--surface` | `#ffffff` | verified |
| `--surface-muted` | `#f6f4f6` | inferred (between off-white and petal) |
| `--foreground` | `#2b2230` | verified |
| `--foreground-secondary` | `#4b4151` (9.3:1) | inferred |
| `--foreground-muted` | `#6b6271` (5.6:1 on background) | inferred |
| `--border` | site hairline | verified |
| `--border-strong` / `--input` | `#908595` (3.5:1 on white) | inferred. The site's hairline is 1.3:1, below WCAG's 3:1 for form controls |
| `--primary` / `--primary-foreground` | aubergine / petal (9.1:1) | verified pairing (site CTAs) |
| `--primary-hover` | `#3a2e40` | inferred |
| `--primary-soft` | petal | verified |
| `--success` / `--warning` / `--danger` | `#3d6b50` / `#8a5a14` / `#9f2f3a` | inferred (the site has no status colours) |
| `--sidebar-background` / `--sidebar-active` / `--sidebar-border` | white / petal / hairline | derived from verified values |
| `--ring` | aubergine (10:1) | inferred choice of a verified colour |

Tailwind classes: `bg-surface`, `bg-surface-muted`, `text-foreground-muted`, `bg-primary`, `hover:bg-primary-hover`,
`bg-primary-soft`, `border-border`, `border-border-strong`, `text-danger`, `bg-sidebar`, `bg-sidebar-active`… shadcn's
names (`card`, `muted`, `secondary`, `accent`, `destructive`, `input`, `ring`) are mapped onto these, so shadcn
primitives follow the brand automatically.

**Rules:** never write a hex value in JSX; brand colour is an accent (one aubergine panel per page at most); no blue,
purple gradients, neon or multicolour cards; no dark mode (the site has none).

## 2. Typography

| Role | Font | Status | Where |
|---|---|---|---|
| Display | **Cormorant** 400/500/600 + italic (`--font-display`, class `font-heading`) | verified | `h1`–`h3`, welcome heading, panel and card titles |
| Body / UI | **Figtree** (`--font-body`, default `font-sans`) | verified | Everything else: nav, buttons, forms, labels, helper text |

Both are open-licence Google Fonts, loaded with `next/font/google` (self-hosted at build, no layout shift). The site
also defines Instrument Serif and Roboto, but not for visible body text; the app does not load them.

Site scale (verified): h1 85 px, h2 55 px (weight 400, letter-spacing −3/−2 px, line-height ≈ 0.9–1.04), h3 28 px/500,
body 16 px, large 20 px, small 14 px, eyebrow 18 px uppercase, button 16 px.

App scale (inferred from the site, smaller for an application): page h1 44–56 px, section h2 30–34 px, card h3 20–26 px
medium, body 15–16 px, eyebrow 12 px uppercase with 0.14 em tracking (`.eyebrow`).

**The site's signature:** one or two words of a heading set in *Cormorant italic* ("Get *In Touch*", "Your *spaces*",
"Welcome back, *Margaret*."). Use `<em>` inside headings; don't italicise whole headings.

**Differences from the site, on purpose:** the site uses Figtree 300 for body text and Cormorant 20 px for form labels.
The app uses Figtree 400 for body text and Figtree 500 14 px for labels, because form UI must stay readable.

## 3. Shape, space, elevation

| | Value | Status |
|---|---|---|
| Buttons | Fully rounded pill (site: 50 px radius) | verified |
| Inputs | 7 px radius (`rounded-sm`), 44 px tall (site 40 px; raised for touch) | verified radius |
| Small cards | 14 px (`rounded-lg`) | inferred |
| Major panels | 20 px (`rounded-xl`; site section panels use 20 px) | verified |
| Section rhythm | 64–80 px between dashboard sections (site uses 120 px section padding) | inferred |
| Content width | 1200 px max, 16–48 px side padding | inferred |
| Shadows | None on cards. Hierarchy comes from borders, surface tone, spacing and type | inferred (site cards are flat) |

## 4. Components

| Component | File | Notes |
|---|---|---|
| `Button` | `components/ui/button.tsx` | `default` (aubergine pill), `secondary` (petal pill), `outline` (white, strong border), `ghost`, `destructive`, `link`. Sizes: `default` 44 px, `sm` 36 px, `lg` 48 px, `icon*` |
| `Input`, `TextField`, `PasswordField`, `FormError` | `components/ui/input.tsx`, `components/shared/form-field.tsx` | Labels always visible; hint and error linked with `aria-describedby`; aubergine focus ring |
| `BrandLogo` | `components/layout/brand-logo.tsx` | The site's own wordmark PNGs (`public/brand/for-after-logo*.png`, 592×161). Set height only; `tone="light"` on photography |
| `SectionHeading` | `components/shared/section-heading.tsx` | Eyebrow + Cormorant `h2` + optional intro |
| `FeatureCard` | `components/shared/feature-card.tsx` | Icon + title + description + status. With `href`: link with "Open →". Without: inert, "Coming next". `compact`: single row |
| `PageLoader`, `Spinner`, `ErrorState`, `EmptyState` | `components/shared/states.tsx` | Skeletons, never a full-screen spinner; human, non-technical copy |
| App shell | `components/layout/dashboard-shell.tsx` | Sidebar + header + main |
| Navigation config | `components/layout/nav.ts` | Groups, spaces and quick actions. **Step 18 turns an item on by adding its `href`**; nav, dashboard cards and quick actions all follow |

**Icons:** Lucide, 18–20 px, `strokeWidth={1.5}`, always next to a text label; decorative icons are `aria-hidden`.
Feature icons sit in a 44 px petal circle.

## 5. Layout patterns

- **Sidebar (≥1024 px):** white, 288 px, hairline right border, logo with generous space, groups *People* / *Preserve*
  with eyebrow labels. Active item uses a petal background with aubergine text. Unbuilt items are muted and marked "Soon",
  not links.
- **Header:** 80 px, translucent off-white with a hairline bottom border.
  - **Left:** today's date in Cormorant italic (≥1024 px). Below that width, the menu button + logo sit on the left.
  - **Right:** an account pill (white, hairline border, soft shadow on hover). Inside: an aubergine avatar with petal
    Cormorant initials and a petal ring, name + email (≥640 px), and a chevron that turns when open.
  - **The pill opens an account menu:** a petal "Signed in as" card (larger avatar, first name in Cormorant, email),
    then **Log out**. Only real actions go in this menu. Add Profile/Settings when those pages exist (FE-9).
  - No search, bell or settings icons.
- **Mobile/tablet (<1024 px):** menu button + logo in the header; the same navigation in a left sheet (focus-trapped,
  Escape closes). Single-column cards; quick actions become rows.
- **Auth pages:** split screen on ≥1024 px (site photograph + white wordmark + site taglines on the left, form on the
  right), single column with the dark logo below that. No card chrome around the form.
- **Photography:** only the site's own images (`public/brand/together.webp`, `writing.webp`), warm and golden-hour, used
  on the auth panel and the dashboard's "Your For After" panel only. Never in CRUD forms. Decorative (`alt=""`).

## 6. Voice

Human and quiet: "Welcome back, *Margaret*.", "A thoughtful *beginning*.", "What would you like *to do?*",
"Coming next". Never "dashboard overview", "metrics" or "manage your data". Reuse the site's own phrases where they fit
("Leave what matters, for the ones you love", "Your words. Your memories. Always theirs.").

**No invented data:** no counts, progress percentages, storage figures or sample people until an API provides them.

## 7. Accessibility

- Text contrast ≥ 4.5:1 (lowest used: muted text 5.3:1 on `surface-muted`); control borders ≥ 3:1; focus ring
  aubergine at 10:1 with a 2 px outline and offset.
- Touch targets ≥ 44 px (buttons, inputs, nav items, menu button).
- Landmarks: `nav[aria-label=Main]`, `main`, `header`; `aria-current="page"` on the active link; sections are labelled by
  their headings; one `h1` per page.
- Keyboard: every action reachable by Tab; the sheet traps focus and closes on Escape; show/hide password is a real
  `button` with `aria-pressed`.

## 8. Open items for brand approval

- Inferred tokens above (muted text, strong border, hover, status colours, radii other than 7/20 px, spacing).
- Image rights: the two photographs and the logo are copied from the marketing site's uploads. Confirm they are licensed
  for use in the app too.
- An SVG logo would render more sharply than the 592×161 PNG.

## 9. Vault patterns (Step 18)

These extend sections 1–7; no feature has its own visual identity.

| Pattern | Component | Rules |
|---|---|---|
| **Page header** | `shared/page-header.tsx` | Optional back link → eyebrow → Cormorant `h1` with one italic accent word → muted intro → one primary action on the right (stacks under on mobile) |
| **List cards** | `people/person-card.tsx`, message/memory/prompt cards | Whole card is one link, white, hairline border, 14 px radius, darker border on hover. A person card has an initials avatar (petal circle, Cormorant), name, relationship and contact cues ("Email", "Mobile"), never the full private details. No tables, and nothing is a CRM row |
| **Forms** | `shared/form-field.tsx` | Visible labels, "(optional)" marker, hint and error linked with `aria-describedby`. A long form sits in one white panel (≤ 768 px wide). Submit is a pill with a spinner, and the fieldset is disabled while saving. Blank optional fields are sent as `null` |
| **Choice cards** | `ChoiceGroup` | Native radios styled as cards (content type, release timing, category). Checked state is a petal fill with an aubergine border. Arrow keys work |
| **Filter chips** | `FilterChips` | URL-driven (`?category=`), pill links; the active one is aubergine with `aria-current` |
| **Long writing** | `TextAreaField` | 7 px radius, relaxed line height, grows with content. The character counter appears only above 90 % of the limit (20,000), so writing never feels like a quota. Saved text is shown in Cormorant with `whitespace-pre-wrap`, always as text and never HTML |
| **Status badges** | `messages/message-bits.tsx` | Draft: neutral. Scheduled: petal/aubergine. Released: `success` at 10 % tint. Cancelled: muted. Small pills, never saturated |
| **Locked states** | `LockedNotice`, schedule panel | A petal panel with a lock icon that says why and what to do ("Unschedule to edit"). It never changes state by itself. Controls the API would refuse are not rendered |
| **Confirmations** | `shared/confirm-dialog.tsx` | One dialog for every delete, remove or unschedule: Cormorant question title, one plain sentence on the consequence (no overstatement), Cancel (outline) and the action. The action is `destructive` for removals and aubergine for unschedule. It stays open with the safe API error if the call fails |
| **Media** | `media/media-manager.tsx` | Tiles in a 2-column grid. Photos use a lazy signed-URL `<img>` (refetched on error). Audio shows a "Listen" pill and fetches its URL only when pressed. Upload shows a thin aubergine progress bar with Cancel, then "Checking the upload…". Failure is an inline danger panel with Try again. PENDING/FAILED tiles are marked not usable |
| **Recorder** | `media/audio-recorder.tsx` | Muted panel. A pulsing danger dot and timer only while recording. Listen back, then "Use this recording" or Discard. The mic is used only while recording |
| **Explainers** | trusted-contact role, My Wishes disclaimer, death-trigger note | A petal panel with an info or shield icon, 15 px text. Wording is exact and product-approved, never alarming |
| **Toasts** | `sonner` in `providers.tsx` | Bottom-centre aubergine pill for transient confirmations only ("Draft saved", "Photo added"). Errors that need action stay inline |
| **Loading / empty / not found** | `ListSkeleton`, `EmptyState`, `QueryView` | Skeleton rows, never a full-screen spinner. Empty states are warm and suggest one next step. Not found is identical whether an item never existed, was removed or belongs to someone else |

## 10. External portals and safety (Step 19)

Recipients and Trusted Contacts are not Users. They get the same brand but a smaller product.

| Pattern | Component | Rules |
|---|---|---|
| **Portal shell** | `portals/portal-shell.tsx` | Header: logo, a petal "Recipient access" / "Trusted contact access" pill, one nav link ("Messages" / "Accounts"), email (≥ 768 px), ghost "Sign out". Max width 896 px. No sidebar and nothing from the Customer app |
| **Portal gates** | `PortalGate`, `PortalGuestGate` | Each checks only its own `/…-auth/me`. Signed out goes to that portal's own `/sign-in`, never the Customer `/login` |
| **OTP sign-in** | `portals/otp-sign-in.tsx` | Step 1: email, then "Send me a code". Step 2: the API's own generic message in a petal panel, and **one** 6-digit field (not six boxes): `inputMode="numeric"`, `autoComplete="one-time-code"`, digits-only on change (pasting "123 456" works), large centred mono type. "Use a different email" and "Send a new code" after 30 s. The challenge id lives in component state only; the code is cleared after every attempt |
| **Reading view** | `portals/recipient.tsx` | Released text in Cormorant 22 px, `max-w-[65ch]`, `whitespace-pre-wrap`, always as text. Photos open in a dialog lightbox. Audio loads its signed URL only on "Listen". There is no download button |
| **Media errors** | `MediaError` in `media-manager.tsx` | A failed signed URL affects only that item: a muted panel with "Try again" (fetches a fresh URL). An expired URL on `<img>`/`<audio>` refetches automatically |
| **Status pill / card** | `StatusPill`, `AccountStatus`; copy in `lib/death-verification.ts` | One copy table for every case status. Open states use petal/aubergine, closed states are neutral, completed uses the success tint. Never a raw enum, a percentage or a prediction |
| **Role note** | `RoleNote` | Wherever a Trusted Contact acts: "Your report starts a verification process: you don't confirm the death yourself, and a report never releases any messages" |
| **Report form** | `ReportForm` | Optional calendar date (`max` = today, sent as `YYYY-MM-DD`), optional note (2,000), a live **summary** (account, date or "Not provided"), then an explicit checkbox ("…does not confirm a death or release any messages"). Action: "Submit report". A 409 ("already submitted" / "not accepting") is an expected state panel, not an error |
| **Safety banner** | `layout/safety-banner.tsx` | On every Customer page while `canConfirmAlive`: petal panel with a 4 px aubergine left edge (visible, not red), Cormorant heading "We've received a report about your account", the safeguard date only if the API returns it, one primary "I'm still alive" → confirmation dialog. It never shows who reported or any note |
