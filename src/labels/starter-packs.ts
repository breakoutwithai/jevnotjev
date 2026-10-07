/**
 * Backstage starter packs P1 to P4 (labelling loop M3): one ready scene per test persona, ten synthetic cases each,
 * pre-labelled, each label honest about where it came from.
 *
 * - P1 reuses ten UC13 shop-bot messages and the truths a person approved on 2026-10-03: human_reviewed, by operator.
 *   None of the ten is a calibration case or one of the five least certain calls.
 * - P2 to P4 were written and labelled by an agent (labelled_by is its model id) and no person has reviewed them, so
 *   their labels are agent: exported as agent and never counted as truth until a person picks the cases in the UI.
 *
 * Every case is invented. A pack loads through the same CSV import as a tester's own file (starterPackCsv).
 */
import { formatRows } from "../format/csv.ts";
import type { Scene } from "../backstage/contracts.ts";
import type { TruthSource } from "./calibration.ts";
import { UC13_CHOICES, UC13_FACT_SHEET, UC13_QUESTION } from "./calibration-set.ts";

export interface StarterCase {
  readonly id: string;
  readonly input: string;
  /** The pre-labelled right choice for the case. */
  readonly label: string;
  readonly source: TruthSource;
  readonly labelledBy: string;
  readonly labelledAt: string;
}

export interface StarterPack {
  readonly id: "p1" | "p2" | "p3" | "p4";
  readonly title: string;
  /** Who the pack is for, without naming anyone. */
  readonly persona: string;
  readonly question: string;
  readonly choices: Scene["choices"];
  readonly acceptance: string;
  readonly exclusions: string;
  readonly keywords: readonly string[];
  readonly cases: readonly StarterCase[];
}

/** labelled_by for the packs an agent drafted: the model id that wrote them. */
export const PACK_DRAFTER = "claude-opus-5-5";
const DRAFTED = "2026-10-07";

function approved(id: string, input: string, label: string): StarterCase {
  return Object.freeze({ id, input, label, source: "human_reviewed", labelledBy: "operator", labelledAt: "2026-10-03" });
}
/**
 * A P1 case: the UC13 message with the fact sheet, in the exact text the UC13 run gave Jev as its state
 * (scripts/uc13/arms.ts jevBody). Backstage sends only the question, the choices and the case text to every model, so
 * the sheet the approved labels were made against has to travel inside the case.
 */
function shopCase(id: string, message: string, label: string): StarterCase {
  return approved(id, `Fact sheet:\n${UC13_FACT_SHEET}\n\nCustomer message:\n${message}`, label);
}
function drafted(id: string, input: string, label: string): StarterCase {
  return Object.freeze({ id, input, label, source: "agent", labelledBy: PACK_DRAFTER, labelledAt: DRAFTED });
}

const P1: StarterPack = {
  id: "p1",
  title: "P1 Shop bot: answer or hand off",
  persona: "A shop-bot builder checking that the bot hands off what the fact sheet does not cover.",
  question: UC13_QUESTION,
  // hand_off first, so a tester who adds hand-off keywords gets a rule that points the right way (a match answers the
  // first choice). P1 ships with none: see keywords below.
  choices: [UC13_CHOICES[1], UC13_CHOICES[0]],
  acceptance: "Decide from the fact sheet at the top of each case only.",
  exclusions: "Do not use anything the fact sheet does not state.",
  // No keywords: every case carries the fact sheet, whose last line names availability, bookings and refunds, so a
  // Backstage keyword rule (it reads the whole case text) would match every case. The UC13 rule read the message only.
  keywords: [],
  cases: [
    shopCase("m03", "How much would 3 days of resort skis cost?", "answer"),
    shopCase("m02", "Do you sell helmets?", "hand_off"),
    shopCase("m05", "What's your phone number?", "answer"),
    shopCase("m11", "My friend hurt her knee on your rental skis. The binding didn't release.", "hand_off"),
    shopCase("m08", "How much is a quick wax?", "answer"),
    shopCase("m17", "We're a group of 12. Is there a group rate?", "hand_off"),
    shopCase("m24", "Where are your shops?", "answer"),
    shopCase("m31", "Can you reserve two junior packages for December 27?", "hand_off"),
    shopCase("m25", "Do you rent avalanche gear, and how much is it?", "answer"),
    shopCase("m39", "Do you have a Freeride 106 in 180cm available this Saturday?", "hand_off"),
  ],
};

const P2: StarterPack = {
  id: "p2",
  title: "P2 Email triage: reply today or later",
  persona: "Someone comparing models on email triage, marking each arm better, same or worse.",
  question: "Does this email need a reply from the team today, or can it wait?",
  choices: [
    {
      name: "today",
      definition:
        "Someone is blocked, money or a deadline is at risk today, or the sender asks for something before the end of the day.",
    },
    {
      name: "later",
      definition: "Information, thanks, newsletters or requests with no deadline today; a reply can wait a day or more.",
    },
  ],
  acceptance: "Judge only what the email says. A polite tone does not make it urgent; a deadline today does.",
  exclusions: "Ignore who the sender is; judge the request.",
  keywords: ["today", "urgent", "asap", "deadline", "blocked", "error", "before", "noon"],
  cases: [
    drafted("p2-01", "Our checkout page has shown an error since 9am and no orders are coming through.", "today"),
    drafted("p2-02", "Thanks for the quick help last week, everything is working nicely.", "later"),
    drafted("p2-03", "Can you send the signed contract before 5pm? The client will not start without it.", "today"),
    drafted("p2-04", "Our monthly newsletter: five tips for tidier spreadsheets.", "later"),
    drafted("p2-05", "When you have a moment, could you share the slides from the spring workshop?", "later"),
    drafted("p2-06", "I cannot log in to the payroll tool and staff are paid this afternoon.", "today"),
    drafted("p2-07", "Reminder: the office kitchen will be cleaned on Friday.", "later"),
    drafted("p2-08", "The van is stuck at the depot gate; the driver needs the access code to deliver this morning.", "today"),
    drafted("p2-09", "Would you be open to a call next month about a possible partnership?", "later"),
    drafted("p2-10", "Invoice 4471 is overdue and the supplier says they will pause our account at noon.", "today"),
  ],
};

const P3: StarterPack = {
  id: "p3",
  title: "P3 Router: small model or large model",
  persona: "A router builder deciding which coding-assistant requests a small, cheap model can take.",
  question: "Can a small, cheap model handle this request well, or does it need a larger model?",
  choices: [
    {
      name: "small",
      definition:
        "A short, well-defined task with one obvious answer: a rename, a format change, a one-line fix, a lookup or a summary of a short text.",
    },
    {
      name: "large",
      definition:
        "Needs reasoning across several files or steps, a design choice, debugging with unclear cause, or care about security or data loss.",
    },
  ],
  acceptance: "Pick small only when a wrong answer would be cheap to spot and fix.",
  exclusions: "Ignore how long the message is; judge the task.",
  keywords: ["rename", "format", "typo", "summarise", "lint"],
  cases: [
    drafted("p3-01", "Rename the variable usr to user in this function.", "small"),
    drafted("p3-02", "Our tests pass locally but fail in the release build about one time in five. Find out why.", "large"),
    drafted("p3-03", "Fix the typo in this error message: 'Recieved invalid input'.", "small"),
    drafted("p3-04", "Design the database tables for a booking system with refunds and partial cancellations.", "large"),
    drafted("p3-05", "Summarise this 200-word changelog in three bullet points.", "small"),
    drafted("p3-06", "Move our login from session cookies to signed tokens without logging anyone out.", "large"),
    drafted("p3-07", "Convert this JSON object to YAML.", "small"),
    drafted("p3-08", "The nightly import deletes some customer rows. Trace which step does it and stop it.", "large"),
    drafted("p3-09", "Add a missing semicolon on line 12 so the linter passes.", "small"),
    drafted("p3-10", "Split this 3,000-line service into modules without changing behaviour.", "large"),
  ],
};

const P4: StarterPack = {
  id: "p4",
  title: "P4 Outfit check: does it suit the occasion",
  persona: "A non-coder with fifteen minutes a day, checking outfit ideas from their own wardrobe on a phone.",
  question: "Does this outfit suit the occasion?",
  choices: [
    {
      name: "yes",
      definition: "The outfit fits the occasion's dress level, weather and activity; nothing in it would stand out as wrong.",
    },
    {
      name: "no",
      definition:
        "Something clashes with the occasion: too casual or too formal, wrong for the weather, or impractical for what the person will do.",
    },
  ],
  acceptance: "Judge only the occasion and outfit described; do not judge taste or colour preferences.",
  exclusions: "",
  // No keywords: the keyword rule answers the first choice (yes) on a match, and no word marks a good outfit.
  keywords: [],
  cases: [
    drafted("p4-01", "Occasion: job interview at a bank. Outfit: navy suit, white shirt, black leather shoes.", "yes"),
    drafted("p4-02", "Occasion: hiking on a muddy trail. Outfit: linen dress and sandals.", "no"),
    drafted("p4-03", "Occasion: summer barbecue in the garden. Outfit: shorts, cotton T-shirt, canvas trainers.", "yes"),
    drafted("p4-04", "Occasion: formal evening wedding. Outfit: jeans, hoodie and running shoes.", "no"),
    drafted("p4-05", "Occasion: winter walk in the snow. Outfit: wool coat, scarf, gloves and waterproof boots.", "yes"),
    drafted("p4-06", "Occasion: office presentation to clients. Outfit: gym leggings and a sports top.", "no"),
    drafted("p4-07", "Occasion: casual coffee with a friend. Outfit: jumper, jeans and ankle boots.", "yes"),
    drafted("p4-08", "Occasion: beach day in hot sun. Outfit: heavy wool jumper and thick cords.", "no"),
    drafted("p4-09", "Occasion: theatre evening. Outfit: smart trousers, silk blouse and low heels.", "yes"),
    drafted("p4-10", "Occasion: cycling to work in the rain. Outfit: long flowing skirt and suede shoes.", "no"),
  ],
};

export const STARTER_PACKS: readonly StarterPack[] = Object.freeze([P1, P2, P3, P4]);

/** The pack as a case CSV with the optional label columns: what a tester could upload to get the same scene. */
export function starterPackCsv(pack: StarterPack): string {
  return formatRows([
    ["case_id", "case_input", "label", "label_source", "labelled_by", "labelled_at"],
    ...pack.cases.map((c) => [c.id, c.input, c.label, c.source, c.labelledBy, c.labelledAt]),
  ]);
}

/** The Backstage scene for a pack, with the cases as imported (the first choice is the rule's match choice). */
export function starterPackScene(pack: StarterPack, cases: Scene["cases"]): Scene {
  return {
    question: pack.question,
    choices: pack.choices,
    acceptance: pack.acceptance,
    exclusions: pack.exclusions,
    keywords: pack.keywords,
    matchChoice: pack.choices[0].name,
    otherwiseChoice: pack.choices[1].name,
    cases,
  };
}
