// V1 development catalogue. The docs leave the final prompt set to product
// discovery (docs/PROJECT_OVERVIEW.md §17); replace the copy here when approved.
// Keys are permanent ids stored with every answer: never rename or reuse one.
// Changing a prompt's wording means bumping its version.

export const MY_STORY_CATEGORIES = [
  'CHILDHOOD',
  'FAMILY',
  'RELATIONSHIPS',
  'MILESTONES',
  'VALUES',
  'LIFE_LESSONS',
  'LEGACY',
] as const;
export type MyStoryCategory = (typeof MY_STORY_CATEGORIES)[number];

export interface MyStoryPrompt {
  key: string;
  category: MyStoryCategory;
  version: number;
  prompt: string;
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
    key: 'family.influence',
    category: 'FAMILY',
    version: 1,
    prompt: 'Who had the greatest influence on you growing up?',
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
    key: 'values.guiding-values',
    category: 'VALUES',
    version: 1,
    prompt: 'What values have guided the way you live?',
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

export const getPromptByKey = (key: string): MyStoryPrompt | undefined =>
  byKey.get(key);
