// V1 catalogue, approved by the product owner 2026-10-08 (Phase 14A;
// docs/my-story.md). Order here is the order shown: categories follow a life,
// prompts within a category likewise.
//
// Rules (approved):
// - A key is a permanent id stored with every answer: never rename or reuse it.
// - Any change to a prompt's wording bumps its version; a change of meaning
//   needs a new key instead.
// - A prompt is never deleted once answers may exist: mark it `retired`. A
//   retired prompt is hidden unless answered, and its answer stays readable,
//   editable and deletable, but it takes no new answers.

export const MY_STORY_CATEGORIES = [
  'CHILDHOOD',
  'FAMILY',
  'RELATIONSHIPS',
  'WORK',
  'TRAVEL',
  'MILESTONES',
  'VALUES',
  'LIFE_LESSONS',
  'LEGACY',
] as const;
export type MyStoryCategory = (typeof MY_STORY_CATEGORIES)[number];

// Approved limit for one answer (Phase 14A); My Wishes keeps 20,000.
export const MY_STORY_ANSWER_MAX = 50_000;

export interface MyStoryPrompt {
  key: string;
  category: MyStoryCategory;
  version: number;
  prompt: string;
  retired?: true;
}

export const MY_STORY_PROMPTS: readonly MyStoryPrompt[] = [
  {
    key: 'childhood.earliest-memory',
    category: 'CHILDHOOD',
    version: 1,
    prompt: 'What is one of your earliest memories?',
  },
  {
    key: 'childhood.home',
    category: 'CHILDHOOD',
    version: 1,
    prompt: 'What was the place you grew up in like?',
  },
  {
    key: 'childhood.school',
    category: 'CHILDHOOD',
    version: 1,
    prompt: 'What do you remember most about your school days?',
  },
  {
    key: 'family.influence',
    category: 'FAMILY',
    version: 1,
    prompt: 'Who had the greatest influence on you growing up?',
  },
  {
    key: 'family.lesson-from-parents',
    category: 'FAMILY',
    version: 1,
    prompt:
      'What is one lesson the people who raised you taught you that stayed with you?',
  },
  {
    key: 'family.tradition',
    category: 'FAMILY',
    version: 1,
    prompt: 'What family tradition has meant the most to you?',
  },
  {
    key: 'relationships.love',
    category: 'RELATIONSHIPS',
    version: 1,
    prompt: 'What has love taught you?',
  },
  {
    key: 'relationships.friendship',
    category: 'RELATIONSHIPS',
    version: 1,
    prompt: 'Tell us about a friendship that has mattered to you.',
  },
  {
    key: 'work.first-job',
    category: 'WORK',
    version: 1,
    prompt: 'What do you remember about your first job?',
  },
  {
    key: 'work.meaningful',
    category: 'WORK',
    version: 1,
    prompt: 'What work or role has felt most meaningful to you?',
  },
  {
    key: 'travel.place',
    category: 'TRAVEL',
    version: 1,
    prompt: 'What is a place you have been that you still think about?',
  },
  {
    key: 'travel.journey',
    category: 'TRAVEL',
    version: 1,
    prompt: 'Tell us about a journey that stayed with you.',
  },
  {
    key: 'milestones.proudest',
    category: 'MILESTONES',
    version: 1,
    prompt: 'What are you most proud of in your life?',
  },
  {
    key: 'milestones.turning-point',
    category: 'MILESTONES',
    version: 1,
    prompt: 'What moment changed the direction of your life?',
  },
  {
    key: 'milestones.favourite-day',
    category: 'MILESTONES',
    version: 1,
    prompt: 'What is a day you would happily live again?',
  },
  {
    key: 'values.guiding-values',
    category: 'VALUES',
    version: 1,
    prompt: 'What values have guided the way you live?',
  },
  {
    key: 'values.kindness',
    category: 'VALUES',
    version: 1,
    prompt: 'What act of kindness has stayed with you?',
  },
  {
    key: 'life-lessons.hardest',
    category: 'LIFE_LESSONS',
    version: 1,
    prompt: 'What lesson took you the longest to learn?',
  },
  {
    key: 'life-lessons.advice',
    category: 'LIFE_LESSONS',
    version: 1,
    prompt: 'What advice would you want the people you love to remember?',
  },
  {
    key: 'life-lessons.younger-self',
    category: 'LIFE_LESSONS',
    version: 1,
    prompt: 'What would you tell your younger self?',
  },
  {
    key: 'legacy.remembered',
    category: 'LEGACY',
    version: 1,
    prompt: 'How would you like to be remembered?',
  },
  {
    key: 'legacy.most-important',
    category: 'LEGACY',
    version: 1,
    prompt:
      'What do you hope the people you love will carry forward from your life?',
  },
];

// Lowercase words joined by hyphens, sections joined by dots. Rejects
// slashes, "..", URLs and anything else path-like.
export const PROMPT_KEY_PATTERN =
  /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;

const byKey = new Map(MY_STORY_PROMPTS.map((p) => [p.key, p]));

export const PROMPT_NOT_FOUND = 'Prompt not found.';

// Retired prompts resolve too: their existing answers stay reachable.
export const getPromptByKey = (key: string): MyStoryPrompt | undefined =>
  byKey.get(key);
