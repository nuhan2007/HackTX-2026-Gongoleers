// What the sprite says in its own words (titles and short lines, not the model's hints). Each situation has a pool of
// phrasings and `PhraseDeck` never gives the same one twice in a row, so it doesn't greet every nudge with the same line.

export type PhrasePool =
  | 'pending' //   it is reading the student's work to write a hint
  | 'offer' //     it noticed they might be stuck but has no hint yet
  | 'hint' //      the heading above a hint
  | 'mistake' //   a step or the final answer is off
  | 'copy' //      the problem was copied differently from how it is written on the homework page
  | 'cheer' //     the answer is right
  | 'cheerLine' // a short extra line under the cheer
  | 'video' //     the heading above a suggested clip
  | 'checkOffer' //the student seems to be moving on without having been checked
  | 'checking' //  checking the answer now
  | 'hello' //     a greeting
  | 'helloLine'; // what it says after the greeting

export const PHRASES: Record<PhrasePool, string[]> = {
  pending: [
    'Let me look at what you have so far…',
    'Peeking at your work…',
    'Reading your steps…',
    'One sec, going over your last few lines…',
    'Taking a careful look at your work…',
    'Let me see where you are…',
  ],
  offer: [
    'Want a nudge?',
    'Stuck on a step? I can help.',
    'Need a fresh angle on this one?',
    'This part can be slippery. Want a hint?',
    'Hitting a wall? A small hint might help.',
    'Hmm, that seems to be giving you trouble.',
  ],
  hint: [
    'Here\'s a thought:',
    'Try looking at it this way:',
    'A little nudge:',
    'Something to think about:',
    'Quick idea:',
    'Consider this:',
    'One thing to try:',
  ],
  mistake: [
    'I spotted something off in your work.',
    'Hold on, one step doesn\'t add up.',
    'Small slip found.',
    'Something went sideways in your work.',
    'There\'s a snag in your work.',
    'Take another look: something isn\'t right.',
  ],
  copy: [
    'Check how you copied the problem.',
    'What you wrote doesn\'t match the problem.',
    'Does that match the original problem?',
    'Your copy of the problem looks different.',
    'Compare your first line with the problem.',
  ],
  cheer: [
    'Great job!',
    'You got it!',
    'Nailed it!',
    'Correct! Nice work!',
    'Yes! That\'s the one.',
    'Well done!',
    'Brilliant, that\'s right!',
    'Excellent work!',
  ],
  cheerLine: [
    'Your steps held together nicely.',
    'That was clean work.',
    'You stuck with it, and it paid off.',
    'Nice thinking all the way through.',
    'That\'s how it\'s done.',
    'Ready for the next one whenever you are.',
    'Proud of that one!',
  ],
  video: [
    'A short clip that might help:',
    'This explains the idea behind it:',
    'Watch this for the missing piece:',
    'Here\'s a quick explainer:',
    'This one covers the concept:',
  ],
  checkOffer: [
    'All done with this one? Want me to check it?',
    'Moving on? I can check your work first.',
    'Finished? I can take a quick look before you go.',
    'Want a quick check of your work before the next one?',
  ],
  checking: [
    'Checking your answer…',
    'Going over your answer…',
    'Let me check that…',
    'Looking at your final answer…',
  ],
  hello: ["Hi, I'm myTA!", 'Hey there, study buddy!', 'myTA reporting for duty!', 'Hello! Ready when you are.', "Hi! I'm your myTA."],
  helloLine: [
    "I'll keep an eye on your work and speak up when you get stuck. I never give away the answer.",
    "I'll tell you the moment a step goes off track, and cheer when you get it right.",
    "Work as you normally do. I'll nudge you when you need it, and not before.",
    "Write it out however you like: on paper, on a board, or right here. I'll follow along.",
  ],
};

/** Picks phrases at random from a pool, using up the whole pool before reusing one and never repeating the last one shown. */
export class PhraseDeck {
  private decks = new Map<PhrasePool, string[]>();
  private last = new Map<PhrasePool, string>();

  constructor(private rng: () => number = Math.random) {}

  next(pool: PhrasePool): string {
    let deck = this.decks.get(pool) ?? [];
    if (deck.length === 0) {
      deck = this.shuffled(PHRASES[pool]);
      // A fresh deck must not open with what the old one ended on.
      const last = this.last.get(pool);
      if (deck.length > 1 && deck[deck.length - 1] === last) [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1], deck[0]];
    }
    const phrase = deck.pop()!;
    this.decks.set(pool, deck);
    this.last.set(pool, phrase);
    return phrase;
  }

  private shuffled(list: string[]): string[] {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
