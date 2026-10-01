import {
  BookOpen,
  Feather,
  Heart,
  House,
  Images,
  Mail,
  PenLine,
  ShieldCheck,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = {
  label: string;
  description: string;
  icon: LucideIcon;
  /** Set once the page exists; items without it render as "Coming next". */
  href?: string;
};

export type NavGroup = { label?: string; items: NavItem[] };

export const HOME: NavItem = {
  label: 'Dashboard',
  description: 'Your private space.',
  icon: House,
  href: '/dashboard',
};

export const PEOPLE_I_LOVE: NavItem = {
  label: 'People I Love',
  description:
    'Keep the people who matter close to the things you choose to preserve.',
  icon: Heart,
  href: '/people',
};

export const TRUSTED_CONTACTS: NavItem = {
  label: 'Trusted Contacts',
  description:
    'The people you trust to let us know when the time comes. Every report is reviewed by our team.',
  icon: ShieldCheck,
  href: '/trusted-contacts',
};

// Wording follows the WordPress site's Features section.
export const SPACES: NavItem[] = [
  {
    label: 'Messages',
    description: 'Write something, or record your voice, for the people you love.',
    icon: Mail,
    href: '/messages',
  },
  {
    label: 'Memory Vault',
    description: 'Photos, recordings and moments you want kept safe.',
    icon: Images,
    href: '/memory-vault',
  },
  {
    label: 'My Story',
    description: 'Your life in your own words, guided by gentle prompts.',
    icon: BookOpen,
    href: '/my-story',
  },
  {
    label: 'My Wishes',
    description: 'How you would like to be remembered. A personal record, not a legal will.',
    icon: Feather,
    href: '/my-wishes',
  },
];

export const NAV_GROUPS: NavGroup[] = [
  { items: [HOME] },
  { label: 'People', items: [PEOPLE_I_LOVE, TRUSTED_CONTACTS] },
  { label: 'Preserve', items: SPACES },
];

/** Dashboard quick actions. */
export const QUICK_ACTIONS: NavItem[] = [
  { label: 'Write a message', description: 'Words for someone you love.', icon: PenLine, href: '/messages/new' },
  { label: 'Add someone you love', description: 'Who your messages are for.', icon: UserPlus, href: '/people/new' },
  { label: 'Save a memory', description: 'A photo, a recording, a moment.', icon: Images, href: '/memory-vault/new' },
];
