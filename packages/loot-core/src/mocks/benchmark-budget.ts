/**
 * A large, deterministic budget used as a basis for UI performance
 * benchmarking. Unlike the demo budget (`./budget.ts`) which only has a
 * handful of payees and a few hundred transactions, this one aims to look
 * like a power user's file: ~4 years of history, a dozen accounts, ~250
 * payees, ~100 categories, ~30k transactions, schedules, rules, tags,
 * templates, carryover, splits, transfers, reconciled history, etc.
 *
 * Everything is generated from a seeded PRNG, and dates are anchored to the
 * current month, so the dataset is identical on every run for a given day.
 */
import { convertForInsert, schema, schemaConfig } from '#server/aql';
import * as budget from '#server/budget/base';
import { storeNoteTemplates } from '#server/budget/template-notes';
import * as db from '#server/db';
import { runMutator } from '#server/mutators';
import * as sheet from '#server/sheet';
import { batchMessages, setSyncingMode } from '#server/sync';
import * as monthUtils from '#shared/months';
import type { Handlers } from '#types/handlers';
import type {
  NewRuleEntity,
  RecurConfig,
  RuleActionEntity,
  RuleConditionEntity,
} from '#types/models';

import { insertDemoTags } from './budget';

const SEED = 20240611;
const MONTHS_OF_HISTORY = 48;
/** How many days past today scheduled bills are entered in advance. */
const FUTURE_DAYS = 10;
/** Multiplier applied to the per-month frequency of discretionary spending. */
const VOLUME = 8;

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

function createRng(seed: number) {
  let state = seed >>> 0;

  // mulberry32
  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function int(min: number, max: number): number {
    return min + Math.floor(next() * (max - min + 1));
  }

  return {
    next,
    int,
    chance(p: number): boolean {
      return next() < p;
    },
    pick<T>(list: readonly T[]): T {
      return list[Math.floor(next() * list.length)];
    },
    /** Amount in cents, skewed toward the low end of the range. */
    skewedCents(min: number, max: number): number {
      const r = next();
      return Math.round((min + (max - min) * r * r) * 100);
    },
    /** Amount in cents, uniform over the range. */
    cents(min: number, max: number): number {
      return Math.round((min + (max - min) * next()) * 100);
    },
    poisson(lambda: number): number {
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= next();
      } while (p > limit);
      return k - 1;
    },
    uuid(): string {
      const hex = '0123456789abcdef';
      let out = '';
      for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) {
          out += '-';
        } else if (i === 14) {
          out += '4';
        } else if (i === 19) {
          out += hex[8 + int(0, 3)];
        } else {
          out += hex[int(0, 15)];
        }
      }
      return out;
    },
  };
}

type Rng = ReturnType<typeof createRng>;

// ---------------------------------------------------------------------------
// Static definitions
// ---------------------------------------------------------------------------

type AccountKey =
  | 'checking'
  | 'joint'
  | 'savings'
  | 'sapphire'
  | 'amex'
  | 'discover'
  | 'citi'
  | 'cash'
  | 'k401'
  | 'brokerage'
  | 'mortgage'
  | 'house';

type AccountDef = {
  key: AccountKey;
  name: string;
  offBudget?: boolean;
  closed?: boolean;
  /** Starting balance in dollars. */
  start: number;
};

const ACCOUNTS: AccountDef[] = [
  { key: 'checking', name: 'Chase Checking', start: 6500 },
  { key: 'joint', name: 'Wells Fargo Joint', start: 3500 },
  { key: 'savings', name: 'Ally Savings', start: 52000 },
  { key: 'sapphire', name: 'Chase Sapphire Visa', start: -1200 },
  { key: 'amex', name: 'Amex Blue Cash', start: -650 },
  { key: 'discover', name: 'Discover It', start: -300 },
  { key: 'citi', name: 'Citi Double Cash', start: -800, closed: true },
  { key: 'cash', name: 'Cash', start: 300 },
  { key: 'k401', name: 'Fidelity 401k', start: 85000, offBudget: true },
  {
    key: 'brokerage',
    name: 'Vanguard Brokerage',
    start: 22000,
    offBudget: true,
  },
  { key: 'mortgage', name: 'Home Mortgage', start: -312000, offBudget: true },
  { key: 'house', name: 'House', start: 385000, offBudget: true },
];

/** Months (from the start of history) during which the closed card was used. */
const CITI_ACTIVE_MONTHS = 12;

type SpendSpec = {
  /** Average number of transactions per month (before VOLUME). */
  perMonth: number;
  /** Amount range in dollars (outflow). */
  min: number;
  max: number;
  payees: string[];
  accounts: AccountKey[];
  tag?: string;
  /** Some transactions get split across other categories. */
  split?: boolean;
  /** Only spend in these calendar months (1-12). */
  calendarMonths?: number[];
  /** Only spend during these history month indexes [from, to). */
  activeMonths?: [number, number];
  /** Not scaled by VOLUME. */
  fixedVolume?: boolean;
};

type CategoryDef = {
  name: string;
  hidden?: boolean;
  carryover?: boolean;
  notes?: string;
  spend?: SpendSpec;
  /** Fixed monthly budget in dollars (savings goals etc). */
  budget?: number;
  /** Ratio of budgeted vs expected spending; < 1 means regular overspending. */
  budgetRatio?: number;
};

type GroupDef = {
  name: string;
  hidden?: boolean;
  isIncome?: boolean;
  categories: CategoryDef[];
};

const CARDS: AccountKey[] = [
  'sapphire',
  'sapphire',
  'amex',
  'discover',
  'citi',
];
const CARDS_AND_DEBIT: AccountKey[] = [...CARDS, 'checking', 'joint'];
const DEBIT: AccountKey[] = ['checking', 'checking', 'joint'];

const GROUPS: GroupDef[] = [
  {
    name: 'Housing',
    categories: [
      { name: 'Mortgage', notes: '#template schedule Mortgage Payment' },
      {
        name: 'Property Tax',
        carryover: true,
        notes: '#template 4300 by 2027-11 repeat every year',
      },
      { name: 'HOA Fees', carryover: true },
      { name: 'Home Insurance', carryover: true },
      {
        name: 'Home Maintenance',
        carryover: true,
        notes: 'Repairs, tools and supplies\n#template 250',
        spend: {
          perMonth: 1,
          min: 15,
          max: 450,
          payees: [
            'Home Depot',
            "Lowe's",
            'Ace Hardware',
            'Sherwin-Williams',
            'Roto-Rooter',
            'Mr. Handyman',
          ],
          accounts: CARDS_AND_DEBIT,
          tag: 'home-improvement',
        },
      },
      {
        name: 'Furniture',
        spend: {
          perMonth: 0.1,
          min: 150,
          max: 1500,
          payees: [
            'Pottery Barn',
            'West Elm',
            'Ashley Furniture',
            'Crate & Barrel',
            'IKEA',
          ],
          accounts: CARDS,
          fixedVolume: true,
        },
      },
      {
        name: 'Lawn & Garden',
        spend: {
          perMonth: 0.5,
          min: 15,
          max: 150,
          payees: ['Green Thumb Landscaping', 'Pike Nurseries', 'TruGreen'],
          accounts: CARDS_AND_DEBIT,
          calendarMonths: [3, 4, 5, 6, 7, 8, 9, 10],
        },
      },
    ],
  },
  {
    name: 'Utilities',
    categories: [
      { name: 'Electric', notes: '#template schedule Electric Bill' },
      { name: 'Natural Gas', notes: '#template average 6 months' },
      { name: 'Water & Sewer' },
      { name: 'Trash', carryover: true },
      { name: 'Internet', notes: '#template 80' },
      { name: 'Mobile Phone', notes: '#template schedule Verizon' },
    ],
  },
  {
    name: 'Food',
    categories: [
      {
        name: 'Groceries',
        carryover: true,
        notes: 'Weekly shopping\n#template 1400',
        budgetRatio: 0.95,
        spend: {
          perMonth: 9,
          min: 25,
          max: 220,
          payees: [
            'Kroger',
            'Publix',
            'Whole Foods Market',
            "Trader Joe's",
            'Aldi',
            'Safeway',
            'Wegmans',
            'Sprouts Farmers Market',
            'H-E-B',
            'Food Lion',
            'Harris Teeter',
            'Lidl',
            'Costco',
            'Target',
            'Walmart',
            "Sam's Club",
          ],
          accounts: [...CARDS_AND_DEBIT, 'checking'],
          tag: 'groceries',
          split: true,
        },
      },
      {
        name: 'Restaurants',
        carryover: true,
        budgetRatio: 0.8,
        notes: '#template up to 600',
        spend: {
          perMonth: 5,
          min: 25,
          max: 140,
          payees: [
            'Olive Garden',
            "Chili's",
            "Applebee's",
            'The Cheesecake Factory',
            "P.F. Chang's",
            'Red Lobster',
            'Outback Steakhouse',
            'Texas Roadhouse',
            'Buffalo Wild Wings',
            'Panera Bread',
            'Noodles & Company',
            'Blue Ginger Sushi',
            "Luigi's Trattoria",
            'The Local Tap',
            'Bella Napoli Pizzeria',
            'Taqueria El Sol',
            'Pho Saigon',
            'Thai Orchid',
            'Golden Dragon',
            'Mediterranean Grill',
            'Seasons 52',
            "Ruth's Chris Steak House",
            'Shake Shack',
            'First Watch',
            'Cracker Barrel',
            'IHOP',
            "Denny's",
            'Waffle House',
          ],
          accounts: CARDS,
          tag: 'dining-out',
        },
      },
      {
        name: 'Fast Food',
        budgetRatio: 0.85,
        spend: {
          perMonth: 5,
          min: 6,
          max: 25,
          payees: [
            "McDonald's",
            'Chick-fil-A',
            'Chipotle',
            'Taco Bell',
            "Wendy's",
            'Burger King',
            'Subway',
            'Five Guys',
            'Panda Express',
            'Popeyes',
            "Jersey Mike's",
            'Sonic Drive-In',
            'Qdoba',
            "Zaxby's",
            "Jimmy John's",
          ],
          accounts: CARDS_AND_DEBIT,
          tag: 'dining-out',
        },
      },
      {
        name: 'Coffee Shops',
        budgetRatio: 0.8,
        spend: {
          perMonth: 8,
          min: 3.5,
          max: 9,
          payees: [
            'Starbucks',
            "Dunkin'",
            "Peet's Coffee",
            'Dutch Bros',
            'Caribou Coffee',
            'Blue Bottle Coffee',
            'Bean There Cafe',
            'Corner Perk',
          ],
          accounts: [...CARDS_AND_DEBIT, 'cash'],
        },
      },
      {
        name: 'Alcohol & Bars',
        spend: {
          perMonth: 1.5,
          min: 15,
          max: 90,
          payees: [
            'Total Wine & More',
            'ABC Liquor',
            'The Rusty Nail',
            'BevMo!',
            "O'Malley's Pub",
          ],
          accounts: CARDS,
        },
      },
      {
        name: 'Work Lunches',
        spend: {
          perMonth: 4,
          min: 9,
          max: 18,
          payees: [
            'Sweetgreen',
            'Cava',
            'Potbelly',
            "Jason's Deli",
            'Corner Bakery',
          ],
          accounts: CARDS,
        },
      },
      {
        name: 'Food Delivery',
        budgetRatio: 0.7,
        spend: {
          perMonth: 2,
          min: 18,
          max: 70,
          payees: ['DoorDash', 'Uber Eats', 'Grubhub', 'Instacart'],
          accounts: CARDS,
          tag: 'dining-out',
        },
      },
    ],
  },
  {
    name: 'Transportation',
    categories: [
      {
        name: 'Fuel',
        carryover: true,
        notes: '#template 300',
        spend: {
          perMonth: 3,
          min: 30,
          max: 75,
          payees: [
            'Shell',
            'Exxon',
            'BP',
            'Chevron',
            'Wawa',
            'QuikTrip',
            'Sheetz',
            'RaceTrac',
            'Circle K',
          ],
          accounts: CARDS_AND_DEBIT,
        },
      },
      { name: 'Car Insurance', carryover: true },
      { name: 'Car Payment', notes: '#template schedule Toyota Car Loan' },
      {
        name: 'Car Maintenance',
        carryover: true,
        notes: '#template 75',
        spend: {
          perMonth: 0.35,
          min: 40,
          max: 650,
          payees: [
            'Jiffy Lube',
            'Firestone Complete Auto Care',
            'Discount Tire',
            'Midas',
            'Toyota of Downtown',
            'AutoZone',
            'Advance Auto Parts',
            'Car Wash Express',
          ],
          accounts: CARDS_AND_DEBIT,
          fixedVolume: true,
        },
      },
      {
        name: 'Parking',
        spend: {
          perMonth: 1.5,
          min: 3,
          max: 25,
          payees: ['ParkMobile', 'SP+ Parking', 'LAZ Parking'],
          accounts: CARDS,
        },
      },
      {
        name: 'Tolls',
        hidden: true,
        spend: {
          perMonth: 1,
          min: 2,
          max: 12,
          payees: ['E-ZPass', 'SunPass'],
          accounts: ['sapphire'],
        },
      },
      {
        name: 'Public Transit',
        hidden: true,
        spend: {
          perMonth: 0.5,
          min: 2.5,
          max: 30,
          payees: ['MARTA', 'Metro Transit'],
          accounts: CARDS,
        },
      },
      {
        name: 'Rideshare',
        spend: {
          perMonth: 1,
          min: 12,
          max: 45,
          payees: ['Uber', 'Lyft'],
          accounts: CARDS,
        },
      },
      { name: 'Car Registration', carryover: true },
    ],
  },
  {
    name: 'Health',
    categories: [
      { name: 'Health Insurance' },
      {
        name: 'Doctor',
        carryover: true,
        spend: {
          perMonth: 0.4,
          min: 25,
          max: 250,
          payees: [
            'Piedmont Healthcare',
            'MinuteClinic',
            'Dr. Patel Family Medicine',
            'Urgent Care Center',
            'LabCorp',
            'Quest Diagnostics',
          ],
          accounts: CARDS_AND_DEBIT,
          tag: 'medical',
        },
      },
      {
        name: 'Dentist',
        spend: {
          perMonth: 0.15,
          min: 40,
          max: 400,
          payees: ['Bright Smile Dental', 'Aspen Dental'],
          accounts: CARDS,
          tag: 'medical',
          fixedVolume: true,
        },
      },
      {
        name: 'Pharmacy',
        spend: {
          perMonth: 1,
          min: 5,
          max: 80,
          payees: ['CVS Pharmacy', 'Walgreens', 'Rite Aid'],
          accounts: CARDS_AND_DEBIT,
          tag: 'medical',
        },
      },
      {
        name: 'Vision',
        spend: {
          perMonth: 0.08,
          min: 80,
          max: 350,
          payees: ['LensCrafters', 'Warby Parker'],
          accounts: CARDS,
          fixedVolume: true,
        },
      },
      { name: 'Gym', notes: '#template 25' },
    ],
  },
  {
    name: 'Personal Care',
    categories: [
      {
        name: 'Haircuts',
        spend: {
          perMonth: 0.7,
          min: 25,
          max: 75,
          payees: [
            'Great Clips',
            'Supercuts',
            'The Barber Shop',
            'Salon Bellezza',
          ],
          accounts: [...CARDS, 'cash'],
        },
      },
      {
        name: 'Cosmetics',
        spend: {
          perMonth: 0.7,
          min: 12,
          max: 90,
          payees: ['Sephora', 'Ulta Beauty', 'Bath & Body Works'],
          accounts: CARDS,
        },
      },
      {
        name: 'Spa & Massage',
        spend: {
          perMonth: 0.15,
          min: 60,
          max: 160,
          payees: ['Massage Envy', 'Hand & Stone'],
          accounts: CARDS,
          fixedVolume: true,
        },
      },
    ],
  },
  {
    name: 'Shopping',
    categories: [
      {
        name: 'Clothing',
        carryover: true,
        budgetRatio: 0.9,
        spend: {
          perMonth: 1.5,
          min: 20,
          max: 180,
          payees: [
            'Old Navy',
            'Gap',
            'Nordstrom',
            "Macy's",
            "Kohl's",
            'H&M',
            'Zara',
            'Uniqlo',
            'Nike',
            'Lululemon',
            'TJ Maxx',
            'Marshalls',
            'REI',
          ],
          accounts: CARDS,
          tag: 'clothing',
        },
      },
      {
        name: 'Electronics',
        spend: {
          perMonth: 0.3,
          min: 25,
          max: 900,
          payees: ['Best Buy', 'Apple Store', 'Micro Center', 'Newegg'],
          accounts: CARDS,
          fixedVolume: true,
        },
      },
      {
        name: 'Household Supplies',
        spend: {
          perMonth: 2,
          min: 8,
          max: 90,
          payees: [
            'The Container Store',
            'Dollar Tree',
            'HomeGoods',
            'IKEA',
            'Target',
            'Walmart',
          ],
          accounts: CARDS_AND_DEBIT,
          split: true,
        },
      },
      {
        name: 'Online Shopping',
        budgetRatio: 0.85,
        spend: {
          perMonth: 4,
          min: 8,
          max: 150,
          payees: [
            'Amazon',
            'Amazon',
            'Amazon',
            'eBay',
            'Etsy',
            'Wayfair',
            'Zappos',
            'Overstock',
          ],
          accounts: CARDS,
          tag: 'online-shopping',
          split: true,
        },
      },
      {
        name: 'Books',
        spend: {
          perMonth: 0.6,
          min: 8,
          max: 40,
          payees: [
            'Barnes & Noble',
            'Audible',
            'Kindle Store',
            'Half Price Books',
          ],
          accounts: CARDS,
        },
      },
      {
        name: 'Hobbies',
        spend: {
          perMonth: 0.7,
          min: 15,
          max: 200,
          payees: [
            'Michaels',
            'Hobby Lobby',
            'Guitar Center',
            'Jo-Ann Fabrics',
            'Bass Pro Shops',
          ],
          accounts: CARDS,
        },
      },
    ],
  },
  {
    name: 'Kids',
    categories: [
      { name: 'Childcare', notes: '#template schedule Daycare' },
      {
        name: 'School Supplies',
        spend: {
          perMonth: 0.3,
          min: 10,
          max: 120,
          payees: ['Staples', 'Office Depot', 'Scholastic'],
          accounts: CARDS,
          calendarMonths: [1, 7, 8, 9],
          fixedVolume: true,
        },
      },
      {
        name: 'Kids Activities',
        spend: {
          perMonth: 1,
          min: 25,
          max: 180,
          payees: [
            'YMCA',
            'The Little Gym',
            'Soccer Shots',
            'Kumon',
            'Code Ninjas',
          ],
          accounts: CARDS_AND_DEBIT,
        },
      },
      {
        name: 'Toys',
        spend: {
          perMonth: 0.5,
          min: 10,
          max: 90,
          payees: ['LEGO Store', 'Toys R Us', 'GameStop'],
          accounts: CARDS,
        },
      },
      {
        name: 'Allowance',
        hidden: true,
        spend: {
          perMonth: 4,
          min: 5,
          max: 10,
          payees: ['Kids Allowance'],
          accounts: ['cash'],
          fixedVolume: true,
        },
      },
    ],
  },
  {
    name: 'Pets',
    categories: [
      {
        name: 'Pet Food',
        notes: '#template 90',
        spend: {
          perMonth: 1,
          min: 25,
          max: 80,
          payees: ['Chewy', 'PetSmart', 'Petco'],
          accounts: CARDS,
        },
      },
      {
        name: 'Vet',
        carryover: true,
        spend: {
          perMonth: 0.2,
          min: 60,
          max: 450,
          payees: ['Banfield Pet Hospital', 'VCA Animal Hospital'],
          accounts: CARDS,
          fixedVolume: true,
        },
      },
      {
        name: 'Pet Supplies',
        spend: {
          perMonth: 0.4,
          min: 10,
          max: 60,
          payees: ['Chewy', 'PetSmart'],
          accounts: CARDS,
        },
      },
      { name: 'Pet Insurance' },
    ],
  },
  {
    name: 'Entertainment',
    categories: [
      {
        name: 'Movies',
        spend: {
          perMonth: 0.7,
          min: 12,
          max: 55,
          payees: ['AMC Theatres', 'Regal Cinemas', 'Fandango'],
          accounts: CARDS,
          tag: 'entertainment',
        },
      },
      {
        name: 'Concerts & Events',
        spend: {
          perMonth: 0.25,
          min: 40,
          max: 300,
          payees: ['Ticketmaster', 'StubHub', 'Eventbrite', 'Live Nation'],
          accounts: CARDS,
          tag: 'entertainment',
          fixedVolume: true,
        },
      },
      {
        name: 'Games',
        spend: {
          perMonth: 0.5,
          min: 5,
          max: 70,
          payees: ['Steam', 'PlayStation Store', 'Nintendo eShop', 'Xbox'],
          accounts: CARDS,
        },
      },
      {
        name: 'Sports',
        spend: {
          perMonth: 0.4,
          min: 15,
          max: 120,
          payees: [
            'Topgolf',
            "Dick's Sporting Goods",
            'Bowlero',
            'City Golf Course',
          ],
          accounts: CARDS,
        },
      },
    ],
  },
  {
    name: 'Subscriptions',
    categories: [
      { name: 'Streaming Video', notes: '#template 80' },
      { name: 'Music' },
      { name: 'Software', carryover: true },
      { name: 'News' },
      { name: 'Cloud Storage' },
    ],
  },
  {
    name: 'Travel',
    categories: [
      {
        name: 'Flights',
        carryover: true,
        spend: {
          perMonth: 0.15,
          min: 150,
          max: 900,
          payees: [
            'Delta Air Lines',
            'Southwest Airlines',
            'United Airlines',
            'American Airlines',
          ],
          accounts: ['sapphire'],
          fixedVolume: true,
        },
      },
      {
        name: 'Hotels',
        spend: {
          perMonth: 0.15,
          min: 120,
          max: 600,
          payees: ['Marriott', 'Hilton', 'Hyatt', 'Holiday Inn'],
          accounts: ['sapphire'],
          fixedVolume: true,
        },
      },
      {
        name: 'Vacation Rentals',
        spend: {
          perMonth: 0.06,
          min: 300,
          max: 1800,
          payees: ['Airbnb', 'Vrbo'],
          accounts: ['sapphire'],
          fixedVolume: true,
        },
      },
      {
        name: 'Travel Activities',
        spend: {
          perMonth: 0.15,
          min: 20,
          max: 200,
          payees: ['Viator', 'GetYourGuide', 'Six Flags', 'Walt Disney World'],
          accounts: ['sapphire', 'amex'],
          fixedVolume: true,
        },
      },
      {
        name: 'Rental Cars',
        spend: {
          perMonth: 0.08,
          min: 80,
          max: 450,
          payees: ['Hertz', 'Enterprise Rent-A-Car', 'Avis'],
          accounts: ['sapphire'],
          fixedVolume: true,
        },
      },
    ],
  },
  {
    name: 'Gifts & Giving',
    categories: [
      {
        name: 'Gifts',
        carryover: true,
        spend: {
          perMonth: 0.7,
          min: 15,
          max: 150,
          payees: [
            'Hallmark',
            '1-800-Flowers',
            'Edible Arrangements',
            'Kay Jewelers',
            'Amazon',
          ],
          accounts: CARDS,
          tag: 'gift',
        },
      },
      {
        name: 'Charity',
        spend: {
          perMonth: 0.2,
          min: 20,
          max: 200,
          payees: [
            'GoFundMe',
            "St. Jude Children's Hospital",
            'Local Food Bank',
            'Habitat for Humanity',
          ],
          accounts: CARDS_AND_DEBIT,
          tag: 'tax-deductible',
          fixedVolume: true,
        },
      },
      {
        name: 'Holidays',
        carryover: true,
        spend: {
          perMonth: 4,
          min: 20,
          max: 250,
          payees: [
            'Target',
            'Amazon',
            'Hobby Lobby',
            'Michaels',
            'Best Buy',
            "Macy's",
          ],
          accounts: CARDS,
          calendarMonths: [11, 12],
          fixedVolume: true,
          tag: 'gift',
        },
      },
    ],
  },
  {
    name: 'Education',
    categories: [
      { name: 'Tuition', carryover: true },
      {
        name: 'Courses',
        spend: {
          perMonth: 0.12,
          min: 15,
          max: 300,
          payees: ['Coursera', 'Udemy', 'MasterClass'],
          accounts: CARDS,
          fixedVolume: true,
        },
      },
      { name: 'Student Loan', notes: '#template schedule Nelnet Student Loan' },
    ],
  },
  {
    name: 'Insurance',
    categories: [{ name: 'Life Insurance' }, { name: 'Umbrella Insurance' }],
  },
  {
    name: 'Financial',
    categories: [
      {
        name: 'Bank Fees',
        spend: {
          perMonth: 0.1,
          min: 3,
          max: 35,
          payees: ['Bank Fee'],
          accounts: DEBIT,
          fixedVolume: true,
        },
      },
      { name: 'Interest Charges' },
      { name: 'Tax Prep' },
      { name: 'Accounting', hidden: true },
    ],
  },
  {
    name: 'Taxes',
    categories: [{ name: 'Federal Tax' }, { name: 'State Tax' }],
  },
  {
    name: 'Savings Goals',
    categories: [
      { name: 'Emergency Fund', budget: 400, notes: '#goal 20000' },
      {
        name: 'Vacation Fund',
        budget: 300,
        notes: '#template 3600 by 2027-06',
      },
      { name: 'New Car Fund', budget: 250 },
      { name: 'Home Improvement Fund', budget: 150 },
      {
        name: 'Christmas Fund',
        budget: 100,
        notes: '#template 1200 by 2026-12 repeat every year',
      },
      { name: 'Retirement Contributions' },
      { name: 'Investments' },
    ],
  },
  {
    name: 'Work',
    categories: [
      {
        name: 'Office Supplies',
        spend: {
          perMonth: 0.4,
          min: 8,
          max: 80,
          payees: ['Staples', 'Office Depot'],
          accounts: CARDS,
          tag: 'reimbursable',
        },
      },
      {
        name: 'Business Travel',
        spend: {
          perMonth: 0.12,
          min: 50,
          max: 400,
          payees: ['Amtrak', 'Greyhound'],
          accounts: ['amex'],
          tag: 'reimbursable',
          fixedVolume: true,
        },
      },
      { name: 'Professional Dues' },
    ],
  },
  {
    name: 'Fun Money',
    categories: [
      {
        name: "Alex's Fun Money",
        budget: 150,
        spend: {
          perMonth: 1,
          min: 10,
          max: 80,
          payees: [
            'Steam',
            'Guitar Center',
            'Bass Pro Shops',
            'Topgolf',
            'GameStop',
          ],
          accounts: ['checking', 'sapphire'],
        },
      },
      {
        name: "Sam's Fun Money",
        budget: 150,
        spend: {
          perMonth: 1,
          min: 10,
          max: 80,
          payees: [
            'Sephora',
            'Etsy',
            'Barnes & Noble',
            'Lululemon',
            'Michaels',
          ],
          accounts: ['joint', 'amex'],
        },
      },
    ],
  },
  {
    name: 'Debt',
    categories: [
      { name: 'Personal Loan', hidden: true },
      { name: 'Credit Card Interest' },
    ],
  },
  {
    name: 'Miscellaneous',
    categories: [
      {
        name: 'General',
        spend: {
          perMonth: 1.5,
          min: 5,
          max: 120,
          payees: ['Venmo', 'PayPal', 'Zelle', 'Square Cash'],
          accounts: DEBIT,
        },
      },
      {
        name: 'Cash Spending',
        spend: {
          perMonth: 3,
          min: 3,
          max: 40,
          payees: [
            'Farmers Market',
            'Food Truck',
            'Tip',
            'Vending Machine',
            'Laundromat',
          ],
          accounts: ['cash'],
        },
      },
      {
        name: 'Postage',
        hidden: true,
        spend: {
          perMonth: 0.3,
          min: 3,
          max: 40,
          payees: ['USPS', 'FedEx', 'The UPS Store'],
          accounts: CARDS,
          fixedVolume: true,
        },
      },
    ],
  },
  {
    name: 'Archived',
    hidden: true,
    categories: [
      {
        name: 'Wedding',
        spend: {
          perMonth: 2,
          min: 300,
          max: 3000,
          payees: [
            'The Grand Ballroom',
            'Bloom Florist',
            'Lens & Light Photography',
            "David's Bridal",
          ],
          accounts: ['sapphire', 'checking'],
          activeMonths: [1, 5],
          fixedVolume: true,
        },
      },
      {
        name: 'Old Apartment Rent',
        spend: {
          perMonth: 1,
          min: 1650,
          max: 1650,
          payees: ['Parkside Apartments'],
          accounts: ['checking'],
          activeMonths: [0, 2],
          fixedVolume: true,
        },
      },
      { name: 'Old Gym Membership' },
    ],
  },
  {
    name: 'Income',
    isIncome: true,
    categories: [
      { name: 'Salary' },
      { name: 'Partner Salary' },
      { name: 'Bonus' },
      { name: 'Interest Income' },
      { name: 'Side Hustle' },
      { name: 'Tax Refund' },
      { name: 'Starting Balances' },
    ],
  },
];

/** Categories that split children of shopping trips may be assigned to. */
const SPLIT_CATEGORIES = [
  'Groceries',
  'Household Supplies',
  'Clothing',
  'Electronics',
  'Toys',
  'Pet Food',
  'Pharmacy',
  'Books',
  'Gifts',
];

type Recurrence =
  | { kind: 'monthly'; day: number; interval?: number; phase?: number }
  | { kind: 'yearly'; month: number; day: number }
  | { kind: 'weekly'; interval: number; weekday: number }
  | { kind: 'semimonthly'; days: [number, number] };

type ScheduleDef = {
  name: string;
  /** Payee name, or the account to transfer to. */
  payee: string | { transfer: AccountKey };
  account: AccountKey;
  category: string | null;
  /** Dollars, negative for outflows (from `account`'s point of view). */
  amount: number | [number, number];
  amountOp: 'is' | 'isapprox' | 'isbetween';
  recur: Recurrence;
  /** Yearly raise applied to the amount, as a fraction. */
  raise?: number;
  paycheckSplit?: boolean;
  tag?: string;
};

const SCHEDULES: ScheduleDef[] = [
  {
    name: 'Paycheck',
    payee: 'Acme Corp',
    account: 'checking',
    category: 'Salary',
    amount: 8800,
    amountOp: 'isapprox',
    recur: { kind: 'weekly', interval: 2, weekday: 5 },
    raise: 0.03,
    paycheckSplit: true,
  },
  {
    name: 'Partner Paycheck',
    payee: 'Globex Inc',
    account: 'joint',
    category: 'Partner Salary',
    amount: 5200,
    amountOp: 'isapprox',
    recur: { kind: 'semimonthly', days: [1, 15] },
    raise: 0.025,
    tag: 'income',
  },
  {
    name: 'Mortgage Payment',
    payee: { transfer: 'mortgage' },
    account: 'checking',
    category: 'Mortgage',
    amount: -2150,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 1 },
    tag: 'mortgage',
  },
  {
    name: 'Electric Bill',
    payee: 'Duke Energy',
    account: 'checking',
    category: 'Electric',
    amount: [-220, -90],
    amountOp: 'isbetween',
    recur: { kind: 'monthly', day: 12 },
    tag: 'utilities',
  },
  {
    name: 'Natural Gas',
    payee: 'Piedmont Natural Gas',
    account: 'checking',
    category: 'Natural Gas',
    amount: [-160, -30],
    amountOp: 'isbetween',
    recur: { kind: 'monthly', day: 15 },
    tag: 'utilities',
  },
  {
    name: 'Water',
    payee: 'City Water Utility',
    account: 'checking',
    category: 'Water & Sewer',
    amount: [-85, -45],
    amountOp: 'isbetween',
    recur: { kind: 'monthly', day: 18 },
    tag: 'utilities',
  },
  {
    name: 'Trash Pickup',
    payee: 'Waste Management',
    account: 'checking',
    category: 'Trash',
    amount: -75,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 5, interval: 3, phase: 0 },
  },
  {
    name: 'Internet',
    payee: 'Comcast Xfinity',
    account: 'checking',
    category: 'Internet',
    amount: -79.99,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 20 },
    tag: 'subscription',
  },
  {
    name: 'Verizon',
    payee: 'Verizon Wireless',
    account: 'joint',
    category: 'Mobile Phone',
    amount: -142.5,
    amountOp: 'isapprox',
    recur: { kind: 'monthly', day: 23 },
  },
  {
    name: 'Netflix',
    payee: 'Netflix',
    account: 'sapphire',
    category: 'Streaming Video',
    amount: -15.49,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 7 },
    tag: 'subscription',
  },
  {
    name: 'Hulu',
    payee: 'Hulu',
    account: 'sapphire',
    category: 'Streaming Video',
    amount: -17.99,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 14 },
  },
  {
    name: 'Disney+',
    payee: 'Disney+',
    account: 'amex',
    category: 'Streaming Video',
    amount: -13.99,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 3 },
  },
  {
    name: 'YouTube Premium',
    payee: 'YouTube Premium',
    account: 'discover',
    category: 'Streaming Video',
    amount: -13.99,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 9 },
  },
  {
    name: 'Spotify',
    payee: 'Spotify',
    account: 'amex',
    category: 'Music',
    amount: -10.99,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 10 },
    tag: 'subscription',
  },
  {
    name: 'Adobe Creative Cloud',
    payee: 'Adobe',
    account: 'sapphire',
    category: 'Software',
    amount: -54.99,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 26 },
  },
  {
    name: '1Password',
    payee: '1Password',
    account: 'sapphire',
    category: 'Software',
    amount: -35.88,
    amountOp: 'is',
    recur: { kind: 'yearly', month: 4, day: 11 },
  },
  {
    name: 'Microsoft 365',
    payee: 'Microsoft',
    account: 'amex',
    category: 'Software',
    amount: -99.99,
    amountOp: 'is',
    recur: { kind: 'yearly', month: 9, day: 2 },
  },
  {
    name: 'iCloud',
    payee: 'Apple iCloud',
    account: 'discover',
    category: 'Cloud Storage',
    amount: -2.99,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 17 },
  },
  {
    name: 'New York Times',
    payee: 'New York Times',
    account: 'sapphire',
    category: 'News',
    amount: -17,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 21 },
  },
  {
    name: 'Planet Fitness',
    payee: 'Planet Fitness',
    account: 'checking',
    category: 'Gym',
    amount: -24.99,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 17 },
  },
  {
    name: 'Car Insurance',
    payee: 'GEICO',
    account: 'checking',
    category: 'Car Insurance',
    amount: -690,
    amountOp: 'isapprox',
    recur: { kind: 'monthly', day: 8, interval: 6, phase: 2 },
  },
  {
    name: 'Home Insurance',
    payee: 'State Farm',
    account: 'checking',
    category: 'Home Insurance',
    amount: -1450,
    amountOp: 'isapprox',
    recur: { kind: 'yearly', month: 6, day: 1 },
  },
  {
    name: 'Property Tax',
    payee: 'County Tax Collector',
    account: 'checking',
    category: 'Property Tax',
    amount: -4200,
    amountOp: 'isapprox',
    recur: { kind: 'yearly', month: 11, day: 15 },
  },
  {
    name: 'Car Registration',
    payee: 'DMV',
    account: 'checking',
    category: 'Car Registration',
    amount: -185,
    amountOp: 'is',
    recur: { kind: 'yearly', month: 3, day: 20 },
  },
  {
    name: 'Life Insurance',
    payee: 'Northwestern Mutual',
    account: 'checking',
    category: 'Life Insurance',
    amount: -48,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 28 },
  },
  {
    name: 'Umbrella Policy',
    payee: 'State Farm',
    account: 'checking',
    category: 'Umbrella Insurance',
    amount: -320,
    amountOp: 'is',
    recur: { kind: 'yearly', month: 2, day: 10 },
  },
  {
    name: 'Pet Insurance',
    payee: 'Trupanion',
    account: 'sapphire',
    category: 'Pet Insurance',
    amount: -52.13,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 4 },
  },
  {
    name: 'HOA Dues',
    payee: 'Oakwood HOA',
    account: 'checking',
    category: 'HOA Fees',
    amount: -225,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 1, interval: 3, phase: 1 },
  },
  {
    name: 'Toyota Car Loan',
    payee: 'Toyota Financial Services',
    account: 'checking',
    category: 'Car Payment',
    amount: -389,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 25 },
  },
  {
    name: 'Nelnet Student Loan',
    payee: 'Nelnet',
    account: 'joint',
    category: 'Student Loan',
    amount: -310,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 16 },
  },
  {
    name: 'Daycare',
    payee: 'Bright Horizons',
    account: 'joint',
    category: 'Childcare',
    amount: -285,
    amountOp: 'is',
    recur: { kind: 'weekly', interval: 1, weekday: 1 },
  },
  {
    name: 'Red Cross Donation',
    payee: 'American Red Cross',
    account: 'amex',
    category: 'Charity',
    amount: -25,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 1 },
    tag: 'tax-deductible',
  },
  {
    name: 'Amazon Prime',
    payee: 'Amazon Prime',
    account: 'sapphire',
    category: 'Online Shopping',
    amount: -139,
    amountOp: 'is',
    recur: { kind: 'yearly', month: 2, day: 6 },
  },
  {
    name: 'Tuition',
    payee: 'State University Bursar',
    account: 'savings',
    category: 'Tuition',
    amount: -2400,
    amountOp: 'isapprox',
    recur: { kind: 'monthly', day: 10, interval: 6, phase: 0 },
  },
  {
    name: 'Savings Transfer',
    payee: { transfer: 'savings' },
    account: 'checking',
    category: null,
    amount: -500,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 2 },
  },
  {
    name: '401k Contribution',
    payee: { transfer: 'k401' },
    account: 'checking',
    category: 'Retirement Contributions',
    amount: -600,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 3 },
    tag: 'retirement',
  },
  {
    name: 'Brokerage Investment',
    payee: { transfer: 'brokerage' },
    account: 'savings',
    category: 'Investments',
    amount: -500,
    amountOp: 'is',
    recur: { kind: 'monthly', day: 5 },
  },
];

const OTHER_PAYEES = [
  'Starting Balance',
  'Acme Corp Bonus',
  'Ally Bank',
  'Etsy Payout',
  'IRS Tax Refund',
  'Fidelity Employer Match',
  'Vanguard Dividends',
  'Market Gain/Loss',
  'Mortgage Interest',
  'Home Valuation',
  'ATM Withdrawal',
  'Card Interest',
  'TurboTax',
  'H&R Block',
  'IEEE Membership',
  'Costco Gas',
  'Expedia',
  'Splitwise',
  'Reimbursement',
];

const FAVORITE_PAYEES = [
  'Kroger',
  'Starbucks',
  'Amazon',
  'Shell',
  'Chipotle',
  'Target',
  'Acme Corp',
];

const NOTE_SNIPPETS = [
  'Split with Sam',
  'Birthday dinner',
  'Weekly shop',
  'Returned part of it',
  'Work trip #reimbursable',
  'Gift for Mom #gift',
  'Keep receipt #tax-deductible',
  'Unexpected repair #emergency',
  'Treat yourself #splurge',
  'Date night',
  'For the party',
  'Stocking up',
  'Paid by card at counter',
  'Coupon applied',
  'Kids came along',
];

// ---------------------------------------------------------------------------
// Generation (pure, no database access)
// ---------------------------------------------------------------------------

type GenChild = {
  id: string;
  amount: number;
  category: string | null;
  payee?: string;
  notes?: string;
};

type GenTransaction = {
  id: string;
  account: AccountKey;
  date: string;
  amount: number;
  payee: string | null;
  transferAccount?: AccountKey;
  transferId?: string;
  category: string | null;
  notes?: string;
  importedPayee?: string;
  schedule?: string;
  startingBalance?: boolean;
  children?: GenChild[];
};

type GeneratedBudget = {
  startMonth: string;
  months: string[];
  transactions: GenTransaction[];
  payees: string[];
  /** Planned monthly budget amounts, keyed by month then category name. */
  budgets: Map<string, Map<string, number>>;
  /** Amount held for the next month, keyed by month. */
  held: Map<string, number>;
};

function pad2(n: number) {
  return n < 10 ? '0' + n : String(n);
}

function dateInMonth(month: string, day: number): string {
  const last = monthUtils.getDay(monthUtils.getMonthEnd(month + '-01'));
  return `${month}-${pad2(Math.min(day, last))}`;
}

function weekday(date: string): number {
  return monthUtils._parse(date).getDay();
}

function bankCode(payee: string): string {
  return payee
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

function occurrences(
  recur: Recurrence,
  months: string[],
  startDay: string,
  endDay: string,
): string[] {
  const dates: string[] = [];
  switch (recur.kind) {
    case 'monthly':
      months.forEach((month, idx) => {
        const interval = recur.interval ?? 1;
        if ((idx - (recur.phase ?? 0)) % interval === 0) {
          dates.push(dateInMonth(month, recur.day));
        }
      });
      break;
    case 'semimonthly':
      for (const month of months) {
        dates.push(dateInMonth(month, recur.days[0]));
        dates.push(dateInMonth(month, recur.days[1]));
      }
      break;
    case 'yearly':
      for (const month of months) {
        if (Number(month.slice(5, 7)) === recur.month) {
          dates.push(dateInMonth(month, recur.day));
        }
      }
      break;
    case 'weekly': {
      let date = startDay;
      while (weekday(date) !== recur.weekday) {
        date = monthUtils.addDays(date, 1);
      }
      while (date <= endDay) {
        dates.push(date);
        date = monthUtils.addDays(date, 7 * recur.interval);
      }
      break;
    }
    default:
      break;
  }
  return dates.filter(d => d >= startDay && d <= endDay);
}

function recurConfig(recur: Recurrence, start: string): RecurConfig {
  switch (recur.kind) {
    case 'monthly':
      return {
        start,
        frequency: 'monthly',
        interval: recur.interval ?? 1,
        patterns: [],
        skipWeekend: false,
        weekendSolveMode: 'after',
        endMode: 'never',
      };
    case 'semimonthly':
      return {
        start,
        frequency: 'monthly',
        interval: 1,
        patterns: recur.days.map(value => ({ type: 'day' as const, value })),
        skipWeekend: true,
        weekendSolveMode: 'before',
        endMode: 'never',
      };
    case 'yearly':
      return {
        start,
        frequency: 'yearly',
        interval: 1,
        patterns: [],
        skipWeekend: false,
        weekendSolveMode: 'after',
        endMode: 'never',
      };
    case 'weekly':
      return {
        start,
        frequency: 'weekly',
        interval: recur.interval,
        patterns: [],
        skipWeekend: false,
        weekendSolveMode: 'after',
        endMode: 'never',
      };
    default:
      throw new Error('Unknown recurrence');
  }
}

function allCategoryDefs(): CategoryDef[] {
  return GROUPS.flatMap(g => g.categories);
}

export function generateBenchmarkData(
  today: string = monthUtils.currentDay(),
): GeneratedBudget {
  const rng = createRng(SEED);
  const idRng = createRng(SEED ^ 0x5bd1e995);

  const currentMonth = monthUtils.monthFromDate(today);
  const startMonth = monthUtils.subMonths(currentMonth, MONTHS_OF_HISTORY - 1);
  const startDay = startMonth + '-01';
  const futureDay = monthUtils.addDays(today, FUTURE_DAYS);
  const months = monthUtils.rangeInclusive(startMonth, currentMonth);
  const allMonths = monthUtils.rangeInclusive(
    startMonth,
    monthUtils.monthFromDate(futureDay),
  );

  const transactions: GenTransaction[] = [];
  const payeeSet = new Set<string>();

  function addPayee(name: string | null) {
    if (name) {
      payeeSet.add(name);
    }
  }

  function bankLike(account: AccountKey) {
    return (
      account !== 'cash' && !ACCOUNTS.find(a => a.key === account)?.offBudget
    );
  }

  function add(txn: Omit<GenTransaction, 'id'>): GenTransaction {
    const full: GenTransaction = { id: idRng.uuid(), ...txn };
    if (
      full.payee &&
      !full.transferAccount &&
      !full.startingBalance &&
      bankLike(full.account) &&
      rng.chance(0.85)
    ) {
      full.importedPayee = `${bankCode(full.payee)} ${rng.int(1000, 9999)}`;
    }
    addPayee(full.payee);
    full.children?.forEach(c => addPayee(c.payee ?? null));
    transactions.push(full);
    return full;
  }

  function addTransfer(
    from: AccountKey,
    to: AccountKey,
    date: string,
    amount: number,
    category: string | null,
    extra: Partial<GenTransaction> = {},
  ) {
    const fromSide = add({
      account: from,
      date,
      amount: -amount,
      payee: null,
      transferAccount: to,
      category,
      ...extra,
    });
    const toSide = add({
      account: to,
      date,
      amount,
      payee: null,
      transferAccount: from,
      category: null,
    });
    fromSide.transferId = toSide.id;
    toSide.transferId = fromSide.id;
  }

  function resolveSpendAccount(accounts: AccountKey[], monthIdx: number) {
    let account = rng.pick(accounts);
    if (account === 'citi' && monthIdx >= CITI_ACTIVE_MONTHS) {
      account = 'sapphire';
    }
    return account;
  }

  function makeNotes(spec: SpendSpec | undefined, amount: number) {
    const parts: string[] = [];
    if (rng.chance(0.05)) {
      parts.push(rng.pick(NOTE_SNIPPETS));
    }
    if (spec?.tag && rng.chance(0.2)) {
      parts.push('#' + spec.tag);
    }
    if (amount < -25000 && rng.chance(0.3)) {
      parts.push('#splurge');
    }
    return parts.length ? parts.join(' ') : undefined;
  }

  // Starting balances
  for (const account of ACCOUNTS) {
    add({
      account: account.key,
      date: startDay,
      amount: account.start * 100,
      payee: 'Starting Balance',
      category: account.offBudget ? null : 'Starting Balances',
      startingBalance: true,
    });
  }

  // Discretionary spending
  for (const category of allCategoryDefs()) {
    const spec = category.spend;
    if (!spec) {
      continue;
    }
    months.forEach((month, monthIdx) => {
      if (
        spec.activeMonths &&
        (monthIdx < spec.activeMonths[0] || monthIdx >= spec.activeMonths[1])
      ) {
        return;
      }
      if (
        spec.calendarMonths &&
        !spec.calendarMonths.includes(Number(month.slice(5, 7)))
      ) {
        return;
      }
      const lambda = spec.perMonth * (spec.fixedVolume ? 1 : VOLUME);
      const count = rng.poisson(lambda);
      for (let i = 0; i < count; i++) {
        const date = dateInMonth(month, rng.int(1, 31));
        if (date > today) {
          continue;
        }
        const account = resolveSpendAccount(spec.accounts, monthIdx);
        const payee = rng.pick(spec.payees);
        let amount = -rng.skewedCents(spec.min, spec.max);
        // Occasional refunds
        const isRefund = spec.split && rng.chance(0.02);
        if (isRefund) {
          amount = Math.round(-amount / 2);
        }
        const uncategorized =
          rng.chance(0.012) ||
          (monthUtils.differenceInCalendarDays(today, date) < 7 &&
            rng.chance(0.25));

        let children: GenChild[] | undefined;
        if (spec.split && !isRefund && amount < -3000 && rng.chance(0.08)) {
          const others = SPLIT_CATEGORIES.filter(c => c !== category.name);
          const n = rng.int(2, 3);
          children = [];
          let remaining = amount;
          for (let c = 0; c < n; c++) {
            const childAmount =
              c === n - 1
                ? remaining
                : Math.round(amount * (0.2 + 0.3 * rng.next()));
            remaining -= childAmount;
            children.push({
              id: idRng.uuid(),
              amount: childAmount,
              category: c === 0 ? category.name : rng.pick(others),
              notes: c === 0 ? undefined : makeNotes(undefined, childAmount),
            });
          }
          // Costco runs often include gas, which gets its own payee
          if (payee === 'Costco' && rng.chance(0.6)) {
            const gas = -rng.cents(35, 70);
            children.push({
              id: idRng.uuid(),
              amount: gas,
              category: 'Fuel',
              payee: 'Costco Gas',
            });
            amount += gas;
          }
        }

        add({
          account,
          date,
          amount,
          payee,
          category: children || uncategorized ? null : category.name,
          notes: makeNotes(spec, amount),
          children,
        });
      }
    });
  }

  // Travel bookings split across multiple payees
  months.forEach((month, monthIdx) => {
    if (monthIdx % 4 !== 1) {
      return;
    }
    const date = dateInMonth(month, rng.int(3, 26));
    if (date > today) {
      return;
    }
    const flight = -rng.cents(250, 900);
    const hotel = -rng.cents(300, 1200);
    const car = -rng.cents(100, 400);
    add({
      account: 'sapphire',
      date,
      amount: flight + hotel + car,
      payee: 'Expedia',
      category: null,
      notes: 'Trip booking',
      children: [
        {
          id: idRng.uuid(),
          amount: flight,
          category: 'Flights',
          payee: 'Delta Air Lines',
        },
        {
          id: idRng.uuid(),
          amount: hotel,
          category: 'Hotels',
          payee: 'Marriott',
        },
        {
          id: idRng.uuid(),
          amount: car,
          category: 'Rental Cars',
          payee: 'Hertz',
        },
      ],
    });
  });

  // Shared dinners settled via Splitwise
  months.forEach(month => {
    const count = rng.poisson(2);
    for (let i = 0; i < count; i++) {
      const date = dateInMonth(month, rng.int(1, 28));
      if (date > today) {
        continue;
      }
      const mine = -rng.cents(20, 80);
      const theirs = rng.cents(10, 40);
      add({
        account: 'joint',
        date,
        amount: mine + theirs,
        payee: 'Splitwise',
        category: null,
        children: [
          {
            id: idRng.uuid(),
            amount: mine,
            category: 'Restaurants',
            payee: rng.pick([
              'Olive Garden',
              'Thai Orchid',
              'Shake Shack',
              'The Local Tap',
            ]),
          },
          {
            id: idRng.uuid(),
            amount: theirs,
            category: 'Restaurants',
            payee: 'Reimbursement',
            notes: '#reimbursable',
          },
        ],
      });
    }
  });

  // Schedules: bills, paychecks and recurring transfers
  for (const schedule of SCHEDULES) {
    const bankAccount =
      schedule.account === 'checking' || schedule.account === 'joint';
    const endDay = bankAccount ? futureDay : today;
    const dates = occurrences(schedule.recur, allMonths, startDay, endDay);
    for (const date of dates) {
      const yearsIn = Math.floor(
        monthUtils.differenceInCalendarMonths(date, startDay) / 12,
      );
      const factor = Math.pow(1 + (schedule.raise ?? 0), yearsIn);
      let amount: number;
      if (Array.isArray(schedule.amount)) {
        amount = rng.cents(schedule.amount[0], schedule.amount[1]);
      } else if (schedule.amountOp === 'isapprox') {
        amount = Math.round(
          schedule.amount * factor * 100 * (0.97 + 0.06 * rng.next()),
        );
      } else {
        amount = Math.round(schedule.amount * factor * 100);
      }

      const notes =
        schedule.tag && rng.chance(0.3) ? '#' + schedule.tag : undefined;

      if (typeof schedule.payee !== 'string') {
        addTransfer(
          schedule.account,
          schedule.payee.transfer,
          date,
          -amount,
          schedule.category,
          { schedule: schedule.name, notes },
        );
        continue;
      }

      let children: GenChild[] | undefined;
      if (schedule.paycheckSplit) {
        const gross = Math.round(amount * 1.38);
        const federal = -Math.round(gross * 0.17);
        const state = -Math.round(gross * 0.05);
        const health = amount - gross - federal - state;
        children = [
          {
            id: idRng.uuid(),
            amount: gross,
            category: 'Salary',
            notes: '#income',
          },
          { id: idRng.uuid(), amount: federal, category: 'Federal Tax' },
          { id: idRng.uuid(), amount: state, category: 'State Tax' },
          { id: idRng.uuid(), amount: health, category: 'Health Insurance' },
        ];
      }

      add({
        account: schedule.account,
        date,
        amount,
        payee: schedule.payee,
        category: children ? null : schedule.category,
        schedule: schedule.name,
        notes,
        children,
      });
    }
  }

  // Other income
  months.forEach(month => {
    const m = Number(month.slice(5, 7));
    if (m === 3) {
      add({
        account: 'checking',
        date: dateInMonth(month, 15),
        amount: rng.cents(6000, 11000),
        payee: 'Acme Corp Bonus',
        category: 'Bonus',
        notes: '#income',
      });
    }
    if (m === 4) {
      add({
        account: 'joint',
        date: dateInMonth(month, 20),
        amount: rng.cents(800, 2600),
        payee: 'IRS Tax Refund',
        category: 'Tax Refund',
      });
      add({
        account: 'checking',
        date: dateInMonth(month, 9),
        amount: -rng.cents(60, 120),
        payee: 'TurboTax',
        category: 'Tax Prep',
      });
    }
    if (m === 5) {
      add({
        account: 'checking',
        date: dateInMonth(month, 9),
        amount: -24500,
        payee: 'IEEE Membership',
        category: 'Professional Dues',
      });
    }
    const etsyCount = rng.poisson(2);
    for (let i = 0; i < etsyCount; i++) {
      add({
        account: 'joint',
        date: dateInMonth(month, rng.int(1, 28)),
        amount: rng.cents(40, 450),
        payee: 'Etsy Payout',
        category: 'Side Hustle',
      });
    }
  });

  // A few manually entered future transactions
  for (let i = 1; i <= 4; i++) {
    add({
      account: 'checking',
      date: monthUtils.addDays(today, i * 2),
      amount: -rng.cents(20, 200),
      payee: rng.pick(['Home Depot', 'Kroger', 'Target']),
      category: rng.pick([
        'Home Maintenance',
        'Groceries',
        'Household Supplies',
      ]),
      notes: 'Planned',
    });
  }

  // Remove dates past the horizon (generated from day-of-month clamping)
  for (let i = transactions.length - 1; i >= 0; i--) {
    if (transactions[i].date > futureDay) {
      transactions.splice(i, 1);
    }
  }

  // Per-account monthly net, used to compute payments and sweeps
  function monthlyNet(account: AccountKey) {
    const net = new Map<string, number>();
    for (const t of transactions) {
      if (t.account === account) {
        const month = t.date.slice(0, 7);
        net.set(month, (net.get(month) ?? 0) + t.amount);
      }
    }
    return net;
  }

  // ATM withdrawals to fund the cash account
  {
    const cashNet = monthlyNet('cash');
    months.forEach(month => {
      const spend = -(cashNet.get(month) ?? 0);
      const withdraw = Math.ceil(spend / 2 / 2000) * 2000;
      if (withdraw <= 0) {
        return;
      }
      for (const day of [1, 15]) {
        const date = dateInMonth(month, day);
        if (date <= today) {
          addTransfer('checking', 'cash', date, withdraw, null, {
            notes: 'ATM Withdrawal',
          });
        }
      }
    });
  }

  // Credit card payments: pay last month's charges (and the starting debt)
  for (const card of ['sapphire', 'amex', 'discover', 'citi'] as const) {
    const net = monthlyNet(card);
    const source: AccountKey =
      card === 'amex' || card === 'discover' ? 'joint' : 'checking';
    months.forEach((month, idx) => {
      if (idx === 0) {
        return;
      }
      const prev = months[idx - 1];
      // The first statement also includes the starting balance, which is
      // part of month 0's net already.
      const owed = -(net.get(prev) ?? 0);
      const date = dateInMonth(month, 22);
      if (owed > 0 && date <= today) {
        addTransfer(source, card, date, owed, null, {
          notes: rng.chance(0.2) ? 'Statement payment' : undefined,
        });
      }
    });
  }

  // Interest on investments, mortgage and house value
  {
    const balances = new Map<AccountKey, number>();
    const byMonth = new Map<string, GenTransaction[]>();
    for (const t of transactions) {
      const month = t.date.slice(0, 7);
      const list = byMonth.get(month) ?? [];
      list.push(t);
      byMonth.set(month, list);
    }
    for (const month of months) {
      for (const t of byMonth.get(month) ?? []) {
        balances.set(t.account, (balances.get(t.account) ?? 0) + t.amount);
      }
      const endOfMonth = monthUtils.getMonthEnd(month + '-01');
      const date = endOfMonth <= today ? endOfMonth : today;
      for (const account of ['k401', 'brokerage'] as const) {
        const balance = balances.get(account) ?? 0;
        const change = Math.round(
          balance * (0.006 + (rng.next() - 0.5) * 0.06),
        );
        add({
          account,
          date,
          amount: change,
          payee: 'Market Gain/Loss',
          category: null,
        });
        balances.set(account, balance + change);
      }
      if (month.slice(5, 7) === '03' || month.slice(5, 7) === '09') {
        const dividend = Math.round((balances.get('brokerage') ?? 0) * 0.008);
        add({
          account: 'brokerage',
          date,
          amount: dividend,
          payee: 'Vanguard Dividends',
          category: null,
        });
        balances.set('brokerage', (balances.get('brokerage') ?? 0) + dividend);
      }
      add({
        account: 'k401',
        date: dateInMonth(month, 3) <= today ? dateInMonth(month, 3) : today,
        amount: 30000,
        payee: 'Fidelity Employer Match',
        category: null,
        notes: '#retirement',
      });
      balances.set('k401', (balances.get('k401') ?? 0) + 30000);

      const mortgageBalance = balances.get('mortgage') ?? 0;
      const interest = Math.round(mortgageBalance * 0.0035);
      add({
        account: 'mortgage',
        date: dateInMonth(month, 1) <= today ? dateInMonth(month, 1) : today,
        amount: interest,
        payee: 'Mortgage Interest',
        category: null,
        notes: '#mortgage',
      });
      balances.set('mortgage', mortgageBalance + interest);

      if (month.slice(5, 7) === '01') {
        const value = balances.get('house') ?? 0;
        const appreciation = Math.round(value * (0.02 + rng.next() * 0.04));
        add({
          account: 'house',
          date:
            dateInMonth(month, 15) <= today ? dateInMonth(month, 15) : today,
          amount: appreciation,
          payee: 'Home Valuation',
          category: null,
        });
        balances.set('house', value + appreciation);
      }
    }
  }

  // Month-end sweeps to keep checking accounts in a sane range, plus
  // savings interest.
  {
    const checkingNet = monthlyNet('checking');
    const jointNet = monthlyNet('joint');
    const savingsNet = monthlyNet('savings');
    let checking = 0;
    let joint = 0;
    let savings = 0;
    for (const month of months) {
      checking += checkingNet.get(month) ?? 0;
      joint += jointNet.get(month) ?? 0;
      savings += savingsNet.get(month) ?? 0;
      const date = dateInMonth(month, 28);
      if (date > today) {
        continue;
      }
      for (const [key, balance] of [
        ['checking', checking],
        ['joint', joint],
      ] as const) {
        let delta = 0;
        if (balance < 1500000) {
          delta = 2000000 - balance;
        } else if (balance > 4000000) {
          delta = 2500000 - balance;
        }
        delta = Math.round(delta / 10000) * 10000;
        if (delta > 0) {
          addTransfer('savings', key, date, delta, null, { notes: 'Top up' });
        } else if (delta < 0) {
          addTransfer(key, 'savings', date, -delta, null, { notes: 'Sweep' });
        }
        if (key === 'checking') {
          checking += delta;
        } else {
          joint += delta;
        }
        savings -= delta;
      }
      const interest = Math.max(0, Math.round(savings * 0.0035));
      if (interest > 0) {
        add({
          account: 'savings',
          date:
            monthUtils.getMonthEnd(month + '-01') <= today
              ? monthUtils.getMonthEnd(month + '-01')
              : today,
          amount: interest,
          payee: 'Ally Bank',
          category: 'Interest Income',
        });
        savings += interest;
      }
    }
  }

  // Sort newest first like the register, so sort_order is stable
  transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Budget amounts: each category gets roughly its average monthly
  // spending, scaled by its budget ratio (some are deliberately tight so
  // they get overspent), with a bit of month-to-month noise.
  const budgets = new Map<string, Map<string, number>>();
  const spentByCategory = new Map<string, number>();
  const addSpent = (category: string | null, amount: number) => {
    if (category) {
      spentByCategory.set(
        category,
        (spentByCategory.get(category) ?? 0) - amount,
      );
    }
  };
  for (const t of transactions) {
    if (t.startingBalance || t.date.slice(0, 7) > currentMonth) {
      continue;
    }
    if (t.children) {
      t.children.forEach(c => addSpent(c.category, c.amount));
    } else {
      addSpent(t.category, t.amount);
    }
  }
  const expected = new Map<string, number>();
  for (const group of GROUPS) {
    if (group.isIncome || group.hidden) {
      continue;
    }
    for (const category of group.categories) {
      const spent = spentByCategory.get(category.name) ?? 0;
      if (spent > 0) {
        expected.set(category.name, spent / months.length);
      }
    }
  }

  const incomeCategories = new Set(
    GROUPS.filter(g => g.isIncome).flatMap(g => g.categories.map(c => c.name)),
  );
  const incomeByMonth = new Map<string, number>();
  const startingByMonth = new Map<string, number>();
  const spentByMonth = new Map<string, Map<string, number>>();
  for (const t of transactions) {
    const month = t.date.slice(0, 7);
    const parts = t.children
      ? t.children.map(c => [c.category, c.amount] as const)
      : [[t.category, t.amount] as const];
    for (const [category, amount] of parts) {
      if (!category) {
        continue;
      }
      if (category === 'Starting Balances') {
        startingByMonth.set(month, (startingByMonth.get(month) ?? 0) + amount);
      } else if (incomeCategories.has(category)) {
        incomeByMonth.set(month, (incomeByMonth.get(month) ?? 0) + amount);
      } else {
        const spent = spentByMonth.get(month) ?? new Map<string, number>();
        spent.set(category, (spent.get(category) ?? 0) - amount);
        spentByMonth.set(month, spent);
      }
    }
  }

  const ratios = new Map<string, number>();
  for (const category of allCategoryDefs()) {
    const ratio = category.budgetRatio ?? 1 + rng.next() * 0.3;
    // Overspending in rollover categories never resets, so keep those
    // budgeted at (on average) what is spent.
    ratios.set(category.name, category.carryover ? Math.max(ratio, 1) : ratio);
  }

  // Simulate the envelope budget: the household lives on last month's
  // income (each month's income is held for the next month), and whatever
  // isn't budgeted (minus last month's overspending, which envelope
  // budgeting takes out of "To Budget") goes to the emergency fund, keeping
  // "To Budget" small but positive.
  const balances = new Map<string, number>();
  const held = new Map<string, number>();
  let lastOverspent = 0;
  let lastHeld = 0;
  let toBudget = 0;
  const TO_BUDGET_TARGET = 30000;
  for (const month of months) {
    const spending = new Map<string, number>();
    const goals = new Map<string, number>();
    for (const category of allCategoryDefs()) {
      if (category.budget != null) {
        goals.set(category.name, category.budget * 100);
      } else if (expected.has(category.name)) {
        const amount =
          (expected.get(category.name) ?? 0) *
          (ratios.get(category.name) ?? 1) *
          (0.92 + rng.next() * 0.16);
        spending.set(category.name, Math.round(amount / 1000) * 1000);
      }
    }
    const sum = (map: Map<string, number>) =>
      [...map.values()].reduce((a, b) => a + b, 0);

    // Never budget more than is available: first cut the savings goals,
    // then scale down everything (e.g. early in the current month, when
    // most of the month's income hasn't arrived yet).
    let available =
      toBudget +
      lastHeld +
      (startingByMonth.get(month) ?? 0) -
      lastOverspent -
      TO_BUDGET_TARGET;
    const spendingTotal = sum(spending);
    if (available < spendingTotal) {
      goals.clear();
      const scale = Math.max(0, available) / Math.max(spendingTotal, 1);
      for (const [name, amount] of spending) {
        spending.set(name, Math.floor((amount * scale) / 1000) * 1000);
      }
    } else if (available < spendingTotal + sum(goals)) {
      goals.clear();
    }
    available -= sum(spending) + sum(goals);
    if (available > 0) {
      goals.set(
        'Emergency Fund',
        (goals.get('Emergency Fund') ?? 0) +
          Math.floor(available / 1000) * 1000,
      );
    }
    const monthBudgets = new Map<string, number>();
    for (const [name, amount] of [...spending, ...goals]) {
      if (amount > 0) {
        monthBudgets.set(name, amount);
      }
    }
    toBudget +=
      lastHeld +
      (startingByMonth.get(month) ?? 0) -
      lastOverspent -
      sum(monthBudgets);
    lastHeld = Math.max(0, incomeByMonth.get(month) ?? 0);
    held.set(month, lastHeld);
    budgets.set(month, monthBudgets);

    lastOverspent = 0;
    const spent = spentByMonth.get(month);
    for (const category of allCategoryDefs()) {
      if (incomeCategories.has(category.name)) {
        continue;
      }
      let balance =
        (balances.get(category.name) ?? 0) +
        (monthBudgets.get(category.name) ?? 0) -
        (spent?.get(category.name) ?? 0);
      if (balance < 0 && !category.carryover) {
        lastOverspent += -balance;
        balance = 0;
      }
      balances.set(category.name, balance);
    }
  }

  // Payees: all generated ones plus every name in the definitions
  for (const category of allCategoryDefs()) {
    category.spend?.payees.forEach(addPayee);
  }
  for (const schedule of SCHEDULES) {
    if (typeof schedule.payee === 'string') {
      addPayee(schedule.payee);
    }
  }
  OTHER_PAYEES.forEach(addPayee);

  return {
    startMonth,
    months,
    transactions,
    payees: [...payeeSet].sort(),
    budgets,
    held,
  };
}

// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------

function cleared(date: string, today: string, rng: Rng) {
  const age = monthUtils.differenceInCalendarDays(today, date);
  if (age > 45) {
    return { cleared: true, reconciled: true };
  }
  if (age < 0) {
    return { cleared: false, reconciled: false };
  }
  return { cleared: rng.chance(age < 4 ? 0.3 : 0.85), reconciled: false };
}

type Row = Record<string, string | number | boolean | null | undefined>;

/**
 * Inserts rows straight into a table. This is what import mode does with
 * sync messages anyway (no CRDT messages are recorded), but with one
 * statement per row instead of one per column, which is much faster.
 */
function bulkInsert(table: string, rows: Row[]) {
  db.transaction(() => {
    for (const row of rows) {
      const columns = Object.keys(row).filter(key => row[key] !== undefined);
      const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns
        .map(() => '?')
        .join(', ')})`;
      db.runQuery(
        db.cache(sql),
        columns.map(key => {
          const value = row[key];
          return typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null);
        }),
      );
    }
  });
}

export async function createBenchmarkBudget(handlers: Handlers) {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  let lap = startedAt;
  function mark(name: string) {
    const now = Date.now();
    timings[name] = now - lap;
    lap = now;
  }

  const today = monthUtils.currentDay();
  const data = generateBenchmarkData(today);
  const rng = createRng(SEED + 1);
  mark('generate');

  setSyncingMode('import');
  db.execQuery('PRAGMA journal_mode = OFF');

  db.runQuery('DELETE FROM categories;');
  db.runQuery('DELETE FROM category_groups');

  // Accounts
  const accountIds = new Map<AccountKey, string>();
  await runMutator(async () => {
    for (const account of ACCOUNTS) {
      const id = await handlers['account-create']({
        name: account.name,
        offBudget: account.offBudget,
        closed: account.closed,
      });
      accountIds.set(account.key, id);
    }
  });
  const accountId = (key: AccountKey) => {
    const id = accountIds.get(key);
    if (!id) {
      throw new Error('Unknown account ' + key);
    }
    return id;
  };

  const transferPayees = new Map<AccountKey, string>();
  const transferRows = await db.all<{ id: string; transfer_acct: string }>(
    'SELECT id, transfer_acct FROM payees WHERE transfer_acct IS NOT NULL',
  );
  for (const [key, id] of accountIds) {
    const row = transferRows.find(r => r.transfer_acct === id);
    if (row) {
      transferPayees.set(key, row.id);
    }
  }

  // Payees
  const payeeIds = new Map<string, string>();
  await runMutator(() =>
    batchMessages(async () => {
      for (const name of data.payees) {
        payeeIds.set(name, await handlers['payee-create']({ name }));
      }
    }),
  );
  const payeeId = (name: string) => {
    const id = payeeIds.get(name);
    if (!id) {
      throw new Error('Unknown payee ' + name);
    }
    return id;
  };

  // Categories
  const categoryIds = new Map<string, string>();
  await runMutator(() =>
    batchMessages(async () => {
      for (const group of GROUPS) {
        const groupId = await handlers['category-group-create']({
          name: group.name,
          isIncome: group.isIncome ?? false,
          hidden: group.hidden ?? false,
        });
        for (const category of group.categories) {
          const id = await db.insertCategory(
            {
              name: category.name,
              cat_group: groupId,
              is_income: group.isIncome ? 1 : 0,
              hidden: category.hidden ? 1 : 0,
            },
            { atEnd: true },
          );
          categoryIds.set(category.name, id);
        }
      }
    }),
  );
  const categoryId = (name: string | null) => {
    if (name == null) {
      return null;
    }
    const id = categoryIds.get(name);
    if (!id) {
      throw new Error('Unknown category ' + name);
    }
    return id;
  };
  mark('entities');

  await runMutator(() => batchMessages(() => insertDemoTags(handlers)));

  // Schedule ids are assigned up front so transactions can link to them
  const scheduleIds = new Map<string, string>();
  const idRng = createRng(SEED + 2);
  for (const schedule of SCHEDULES) {
    scheduleIds.set(schedule.name, idRng.uuid());
  }

  // Transactions
  const rows: Row[] = [];
  let sortOrder = 1_000_000_000;
  for (const t of data.transactions) {
    sortOrder += 1024;
    const flags = cleared(t.date, today, rng);
    const offBudget = !!ACCOUNTS.find(a => a.key === t.account)?.offBudget;
    const base: Row = {
      id: t.id,
      account: accountId(t.account),
      date: t.date,
      amount: t.amount,
      payee: t.transferAccount
        ? transferPayees.get(t.transferAccount)
        : t.payee
          ? payeeId(t.payee)
          : null,
      category: offBudget ? null : categoryId(t.category),
      notes: t.notes ?? null,
      imported_payee: t.importedPayee ?? null,
      transfer_id: t.transferId ?? null,
      schedule: t.schedule ? scheduleIds.get(t.schedule) : null,
      starting_balance_flag: t.startingBalance ?? false,
      sort_order: sortOrder,
      cleared: flags.cleared,
      reconciled: flags.reconciled,
    };
    if (t.children) {
      rows.push({ ...base, is_parent: true, category: null });
      for (const child of t.children) {
        rows.push({
          id: child.id,
          account: base.account,
          date: t.date,
          amount: child.amount,
          payee: child.payee ? payeeId(child.payee) : base.payee,
          category: categoryId(child.category),
          notes: child.notes ?? null,
          is_child: true,
          parent_id: t.id,
          sort_order: sortOrder,
          cleared: flags.cleared,
          reconciled: flags.reconciled,
        });
      }
    } else {
      rows.push(base);
    }
  }

  bulkInsert(
    'transactions',
    rows.map(row =>
      convertForInsert(schema, schemaConfig, 'transactions', row),
    ),
  );
  mark('transactions');

  // Budget amounts, rollover flags and money held for next month. These are
  // written before the spreadsheet is loaded so it computes everything once.
  const dbMonth = (month: string) => Number(month.replace('-', ''));
  const budgetRows = new Map<string, Row>();
  for (const [month, amounts] of data.budgets) {
    for (const [name, amount] of amounts) {
      const category = categoryId(name);
      budgetRows.set(`${dbMonth(month)}-${category}`, {
        id: `${dbMonth(month)}-${category}`,
        month: dbMonth(month),
        category,
        amount,
        carryover: 0,
      });
    }
  }
  const budgetMonths = monthUtils.rangeInclusive(
    data.startMonth,
    monthUtils.addMonths(monthUtils.currentMonth(), 12),
  );
  for (const category of allCategoryDefs()) {
    if (!category.carryover) {
      continue;
    }
    const id = categoryId(category.name);
    for (const month of budgetMonths) {
      const key = `${dbMonth(month)}-${id}`;
      const existing = budgetRows.get(key);
      if (existing) {
        existing.carryover = 1;
      } else {
        budgetRows.set(key, {
          id: key,
          month: dbMonth(month),
          category: id,
          amount: 0,
          carryover: 1,
        });
      }
    }
  }
  bulkInsert('zero_budgets', [...budgetRows.values()]);
  bulkInsert(
    'zero_budget_months',
    [...data.held].map(([month, buffered]) => ({ id: month, buffered })),
  );
  mark('budget');

  // Favorite payees
  await runMutator(() =>
    handlers['payees-batch-change']({
      updated: FAVORITE_PAYEES.map(name => ({
        id: payeeId(name),
        favorite: true,
      })),
    }),
  );

  // Bust the cache and reload the spreadsheet
  setSyncingMode('disabled');
  await sheet.reloadSpreadsheet(db);
  await budget.createAllBudgets();
  // The spreadsheet was restored from its (still "clean") cache, so load the
  // budget amounts written above explicitly.
  await sheet.loadUserBudgets(db);
  await sheet.waitOnSpreadsheet();

  mark('spreadsheet');

  // Schedules
  await runMutator(() =>
    batchMessages(async () => {
      for (const schedule of SCHEDULES) {
        const dates = occurrences(
          schedule.recur,
          monthUtils.rangeInclusive(data.startMonth, monthUtils.currentMonth()),
          data.startMonth + '-01',
          today,
        );
        const start = dates[0] ?? today;
        const amountCond: RuleConditionEntity = Array.isArray(schedule.amount)
          ? {
              op: 'isbetween',
              field: 'amount',
              value: {
                num1: Math.round(schedule.amount[0] * 100),
                num2: Math.round(schedule.amount[1] * 100),
              },
            }
          : {
              op: schedule.amountOp === 'isapprox' ? 'isapprox' : 'is',
              field: 'amount',
              value: Math.round(schedule.amount * 100),
            };
        const payee =
          typeof schedule.payee === 'string'
            ? payeeId(schedule.payee)
            : transferPayees.get(schedule.payee.transfer);
        await handlers['schedule/create']({
          schedule: {
            id: scheduleIds.get(schedule.name),
            name: schedule.name,
            posts_transaction: false,
          },
          conditions: [
            { op: 'is', field: 'payee', value: payee ?? '' },
            { op: 'is', field: 'account', value: accountId(schedule.account) },
            {
              op: 'isapprox',
              field: 'date',
              value: recurConfig(schedule.recur, start),
            },
            amountCond,
          ],
        });
      }
    }),
  );
  mark('schedules');

  // Rules
  const rules = buildRules({ payeeId, categoryId, accountId });
  await runMutator(() =>
    batchMessages(async () => {
      for (const rule of rules) {
        const res = await handlers['rule-add'](rule);
        if ('error' in res) {
          throw new Error('Invalid benchmark rule: ' + JSON.stringify(res));
        }
      }
    }),
  );
  mark('rules');

  // Category notes and goal templates
  await runMutator(async () => {
    for (const category of allCategoryDefs()) {
      if (category.notes) {
        await handlers['notes-save']({
          id: categoryId(category.name) ?? '',
          note: category.notes,
        });
      }
    }
    await storeNoteTemplates();
  });

  // A custom report on the dashboard
  await runMutator(async () => {
    const reportId = await handlers['report/create']({
      id: '',
      name: 'Spending by category (benchmark)',
      startDate: monthUtils.subMonths(monthUtils.currentMonth(), 11),
      endDate: monthUtils.currentMonth(),
      isDateStatic: false,
      dateRange: 'Last 12 months',
      mode: 'total',
      groupBy: 'Category',
      interval: 'Monthly',
      balanceType: 'Payment',
      sortBy: 'desc',
      showEmpty: false,
      showOffBudget: false,
      showHiddenCategories: false,
      includeCurrentInterval: true,
      showUncategorized: true,
      trimIntervals: false,
      showTrendLines: false,
      graphType: 'BarGraph',
      conditions: [],
      conditionsOp: 'and',
    });
    const page = await db.first<{ id: string }>(
      'SELECT id FROM dashboard_pages WHERE tombstone = 0 LIMIT 1',
    );
    if (page) {
      await handlers['dashboard-add-widget']({
        type: 'custom-report',
        width: 4,
        height: 2,
        meta: { id: reportId },
        dashboard_page_id: page.id,
      });
    }
  });
  await sheet.waitOnSpreadsheet();
  mark('extras');

  timings.total = Date.now() - startedAt;

  const stats = await getBenchmarkStats();
  const sheetName = monthUtils.sheetForMonth(monthUtils.currentMonth());
  stats.toBudgetCurrentMonth = Number(
    sheet.getCellValue(sheetName, 'to-budget') ?? 0,
  );
  stats.overspentCategoriesCurrentMonth = [...categoryIds.values()].filter(
    id => Number(sheet.getCellValue(sheetName, `leftover-${id}`) ?? 0) < 0,
  ).length;
  return { timings, stats };
}

const STAT_QUERIES = {
  accounts: 'SELECT count(*) AS n FROM accounts WHERE tombstone = 0',
  closedAccounts:
    'SELECT count(*) AS n FROM accounts WHERE tombstone = 0 AND closed = 1',
  offBudgetAccounts:
    'SELECT count(*) AS n FROM accounts WHERE tombstone = 0 AND offbudget = 1',
  payees: 'SELECT count(*) AS n FROM payees WHERE tombstone = 0',
  transferPayees:
    'SELECT count(*) AS n FROM payees WHERE tombstone = 0 AND transfer_acct IS NOT NULL',
  favoritePayees:
    'SELECT count(*) AS n FROM payees WHERE tombstone = 0 AND favorite = 1',
  categoryGroups:
    'SELECT count(*) AS n FROM category_groups WHERE tombstone = 0',
  hiddenCategoryGroups:
    'SELECT count(*) AS n FROM category_groups WHERE tombstone = 0 AND hidden = 1',
  categories: 'SELECT count(*) AS n FROM categories WHERE tombstone = 0',
  hiddenCategories:
    'SELECT count(*) AS n FROM categories WHERE tombstone = 0 AND hidden = 1',
  incomeCategories:
    'SELECT count(*) AS n FROM categories WHERE tombstone = 0 AND is_income = 1',
  transactionRows: 'SELECT count(*) AS n FROM transactions WHERE tombstone = 0',
  transactions:
    'SELECT count(*) AS n FROM transactions WHERE tombstone = 0 AND isChild = 0',
  splitParents:
    'SELECT count(*) AS n FROM transactions WHERE tombstone = 0 AND isParent = 1',
  splitChildren:
    'SELECT count(*) AS n FROM transactions WHERE tombstone = 0 AND isChild = 1',
  multiPayeeSplits: `SELECT count(*) AS n FROM transactions p WHERE p.tombstone = 0 AND p.isParent = 1
      AND EXISTS (SELECT 1 FROM transactions c WHERE c.parent_id = p.id AND c.description != p.description)`,
  transferTransactions:
    'SELECT count(*) AS n FROM transactions WHERE tombstone = 0 AND transferred_id IS NOT NULL',
  scheduledTransactions:
    'SELECT count(*) AS n FROM transactions WHERE tombstone = 0 AND schedule IS NOT NULL',
  reconciledTransactions:
    'SELECT count(*) AS n FROM transactions WHERE tombstone = 0 AND reconciled = 1',
  unclearedTransactions:
    'SELECT count(*) AS n FROM transactions WHERE tombstone = 0 AND cleared = 0',
  uncategorizedTransactions: `SELECT count(*) AS n FROM transactions t JOIN accounts a ON a.id = t.acct
      WHERE t.tombstone = 0 AND a.offbudget = 0 AND t.category IS NULL AND t.isParent = 0 AND t.transferred_id IS NULL`,
  futureTransactions: `SELECT count(*) AS n FROM transactions WHERE tombstone = 0 AND date > ${monthUtils
    .currentDay()
    .replace(/-/g, '')}`,
  transactionsWithNotes:
    "SELECT count(*) AS n FROM transactions WHERE tombstone = 0 AND notes IS NOT NULL AND notes != ''",
  transactionsWithTags:
    "SELECT count(*) AS n FROM transactions WHERE tombstone = 0 AND notes LIKE '%#%'",
  schedules: 'SELECT count(*) AS n FROM schedules WHERE tombstone = 0',
  rules: 'SELECT count(*) AS n FROM rules WHERE tombstone = 0',
  tags: 'SELECT count(*) AS n FROM tags WHERE tombstone = 0',
  monthsBudgeted:
    'SELECT count(DISTINCT month) AS n FROM zero_budgets WHERE amount != 0',
  budgetCells: 'SELECT count(*) AS n FROM zero_budgets WHERE amount != 0',
  carryoverCategories:
    'SELECT count(DISTINCT category) AS n FROM zero_budgets WHERE carryover = 1',
  categoryTemplates:
    "SELECT count(*) AS n FROM notes WHERE note LIKE '%#template%' OR note LIKE '%#goal%'",
  customReports: 'SELECT count(*) AS n FROM custom_reports WHERE tombstone = 0',
  dashboardWidgets: 'SELECT count(*) AS n FROM dashboard WHERE tombstone = 0',
};

export async function getBenchmarkStats() {
  const stats: Record<string, number> = {};
  for (const [name, sql] of Object.entries(STAT_QUERIES)) {
    const row = await db.first<{ n: number }>(sql);
    stats[name] = row?.n ?? 0;
  }
  return stats;
}

function buildRules({
  payeeId,
  categoryId,
  accountId,
}: {
  payeeId: (name: string) => string;
  categoryId: (name: string | null) => string | null;
  accountId: (key: AccountKey) => string;
}): NewRuleEntity[] {
  const rules: NewRuleEntity[] = [];
  const seen = new Set<string>();
  const payeeCategory: Array<[string, string]> = [];
  for (const category of allCategoryDefs()) {
    for (const payee of category.spend?.payees ?? []) {
      if (!seen.has(payee)) {
        seen.add(payee);
        payeeCategory.push([payee, category.name]);
      }
    }
  }

  // Payee renames from the bank's description (pre stage)
  payeeCategory
    .filter((_, idx) => idx % 4 === 0)
    .slice(0, 45)
    .forEach(([payee]) => {
      rules.push({
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [
          { op: 'contains', field: 'imported_payee', value: bankCode(payee) },
        ],
        actions: [{ op: 'set', field: 'payee', value: payeeId(payee) }],
      });
    });

  // Category assignment by payee
  payeeCategory
    .filter((_, idx) => idx % 4 !== 0)
    .slice(0, 45)
    .forEach(([payee, category]) => {
      rules.push({
        stage: null,
        conditionsOp: 'and',
        conditions: [{ op: 'is', field: 'payee', value: payeeId(payee) }],
        actions: [
          { op: 'set', field: 'category', value: categoryId(category) },
        ],
      });
    });

  const set = (field: string, value: unknown): RuleActionEntity => ({
    op: 'set',
    field,
    value,
  });

  // A few more complex rules
  rules.push(
    {
      stage: null,
      conditionsOp: 'and',
      conditions: [
        {
          op: 'oneOf',
          field: 'payee',
          value: ['Amazon', 'eBay', 'Newegg'].map(payeeId),
        },
        { op: 'lt', field: 'amount', value: -20000 },
      ],
      actions: [
        set('category', categoryId('Electronics')),
        { op: 'append-notes', value: ' #online-shopping' },
      ],
    },
    {
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [
        { op: 'contains', field: 'imported_payee', value: 'UBER' },
        { op: 'contains', field: 'imported_payee', value: 'EATS' },
      ],
      actions: [
        set('payee', payeeId('Uber Eats')),
        set('category', categoryId('Food Delivery')),
      ],
    },
    {
      stage: 'post',
      conditionsOp: 'and',
      conditions: [{ op: 'contains', field: 'notes', value: 'work trip' }],
      actions: [{ op: 'append-notes', value: ' #reimbursable' }],
    },
    {
      stage: null,
      conditionsOp: 'and',
      conditions: [
        { op: 'is', field: 'payee', value: payeeId('Costco') },
        { op: 'lt', field: 'amount', value: -15000 },
      ],
      actions: [
        set('category', categoryId('Groceries')),
        { op: 'prepend-notes', value: 'Big Costco run ' },
      ],
    },
    {
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'account', value: accountId('cash') }],
      actions: [set('cleared', true)],
    },
    {
      stage: null,
      conditionsOp: 'or',
      conditions: [
        { op: 'is', field: 'payee', value: payeeId('Venmo') },
        { op: 'is', field: 'payee', value: payeeId('Zelle') },
      ],
      actions: [set('category', categoryId('General'))],
    },
    {
      stage: 'post',
      conditionsOp: 'and',
      conditions: [
        { op: 'is', field: 'category', value: categoryId('Restaurants') ?? '' },
        { op: 'lt', field: 'amount', value: -10000 },
      ],
      actions: [{ op: 'append-notes', value: ' #splurge' }],
    },
    {
      stage: null,
      conditionsOp: 'and',
      conditions: [
        {
          op: 'oneOf',
          field: 'payee',
          value: ['Shell', 'Exxon', 'BP', 'Chevron'].map(payeeId),
        },
      ],
      actions: [set('category', categoryId('Fuel'))],
    },
    {
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'contains', field: 'imported_payee', value: 'AMZN' }],
      actions: [set('payee', payeeId('Amazon'))],
    },
    {
      stage: null,
      conditionsOp: 'and',
      conditions: [
        { op: 'gt', field: 'amount', value: 300000 },
        { op: 'is', field: 'account', value: accountId('checking') },
        { op: 'is', field: 'payee', value: payeeId('Acme Corp') },
      ],
      actions: [set('category', categoryId('Salary')), set('cleared', true)],
    },
  );

  return rules;
}
