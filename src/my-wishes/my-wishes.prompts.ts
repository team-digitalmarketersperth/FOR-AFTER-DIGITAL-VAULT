// V1 development catalogue. The docs list only "possible fields" for My Wishes
// (docs/PROJECT_OVERVIEW.md §18); replace the copy here when product approves
// a final set. Personal preferences and guidance only: no prompt may ask for
// a legal, medical or financial instruction.
// Keys are permanent ids stored with every answer: never rename or reuse one.
// Changing a prompt's wording means bumping its version.

export const MY_WISHES_CATEGORIES = [
  'CEREMONY',
  'ATMOSPHERE',
  'MUSIC_AND_READINGS',
  'PEOPLE_AND_TRADITIONS',
  'PERSONAL_PREFERENCES',
  'PERSONAL_MESSAGE',
  'OTHER',
] as const;
export type MyWishesCategory = (typeof MY_WISHES_CATEGORIES)[number];

export interface MyWishPrompt {
  key: string;
  category: MyWishesCategory;
  version: number;
  prompt: string;
}

export const MY_WISHES_PROMPTS: readonly MyWishPrompt[] = [
  {
    key: 'ceremony.style',
    category: 'CEREMONY',
    version: 1,
    prompt: 'How would you like your farewell or celebration of life to feel?',
  },
  {
    key: 'ceremony.setting',
    category: 'CEREMONY',
    version: 1,
    prompt:
      'Is there a place or type of setting that would feel meaningful to you?',
  },
  {
    key: 'atmosphere.feeling',
    category: 'ATMOSPHERE',
    version: 1,
    prompt: 'What kind of atmosphere would you like people to experience?',
  },
  {
    key: 'music-and-readings.music',
    category: 'MUSIC_AND_READINGS',
    version: 1,
    prompt:
      'Are there any songs or pieces of music that are meaningful to you?',
  },
  {
    key: 'music-and-readings.readings',
    category: 'MUSIC_AND_READINGS',
    version: 1,
    prompt:
      'Are there any readings, poems, passages or words you would like included?',
  },
  {
    key: 'people-and-traditions.involvement',
    category: 'PEOPLE_AND_TRADITIONS',
    version: 1,
    prompt:
      'Are there particular people you would like involved in your farewell?',
  },
  {
    key: 'people-and-traditions.traditions',
    category: 'PEOPLE_AND_TRADITIONS',
    version: 1,
    prompt:
      'Are there any traditions or personal touches you would like remembered?',
  },
  {
    key: 'personal-preferences.details',
    category: 'PERSONAL_PREFERENCES',
    version: 1,
    prompt:
      'Are there any other personal preferences you would like your loved ones to know?',
  },
  {
    key: 'personal-message.remember',
    category: 'PERSONAL_MESSAGE',
    version: 1,
    prompt:
      'Is there anything you would like your loved ones to remember when the time comes?',
  },
  {
    key: 'other.additional-wishes',
    category: 'OTHER',
    version: 1,
    prompt: 'Is there anything else you would like to share about your wishes?',
  },
];

const byKey = new Map(MY_WISHES_PROMPTS.map((p) => [p.key, p]));

export const getWishPromptByKey = (key: string): MyWishPrompt | undefined =>
  byKey.get(key);
