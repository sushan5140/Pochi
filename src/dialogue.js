// All Pochi nagging/celebration lines, keyed by category + escalation level.
// Tone: sarcastic, caring, never insulting. Edit freely — this is the only
// file you should need to touch to change what Pochi says.
//
// Chapter 46: water/food/battery/sleep/break are additionally keyed by
// relationship stage (new/familiar/established) — pickLine(category,
// level, stage) picks from that stage's pool. The 'new' pool in every one
// of these is the ORIGINAL line set verbatim, unchanged from before this
// existed: a fresh install computes stage 'new' by construction (see
// personalityStage.js), so this guarantees zero behavior change for a new
// install, which is the brief's explicit definition-of-done requirement.
// Categories outside this five (entertainment/pomodoro/debugSupport/
// distraction/resolved) are intentionally left as flat arrays — the brief
// names exactly water/food/battery/sleep/break for stage variation, not
// every nag type that exists.

const lines = {
  water: {
    smug: {
      new: [
        "Hey. Water. It's free and you're 60% of it, use some.",
        "Just a friendly reminder that you have a body, and it's thirsty.",
        "Sipping water counts as a break, you know."
      ],
      familiar: [
        "Water time again — you know the drill by now.",
        "This is basically our thing at this point. Water?",
        "Same reminder as always: drink something."
      ],
      established: [
        "You always forget this, don't you? Water. Now.",
        "We've done this dance probably fifty times. Water.",
        "I could set my clock by how often I have to say this. Drink up."
      ]
    },
    judging: {
      new: [
        "Still no water? Bold strategy.",
        "I've been standing here with this bottle for a while now.",
        "Your houseplants are more hydrated than you right now."
      ],
      familiar: [
        "You're doing the thing again where you ignore the water reminder.",
        "This is at least the second time today. C'mon.",
        "I see we're back to pretending I didn't just say something."
      ],
      established: [
        "This is basically a running joke between us at this point — except it's not funny, drink water.",
        "Every. Single. Time. You know how this goes.",
        "I've genuinely lost count of how many times we've been here."
      ]
    },
    angry: {
      new: [
        "WATER. NOW. This isn't a negotiation.",
        "I will keep bringing this up until you drink something.",
        "You've officially out-stubborned a cactus."
      ],
      familiar: [
        "We both know how this ends — you drinking water eventually. Skip to that part.",
        "I'm not asking a third time. Water. Go.",
        "You've done this exact thing before. I remember. Water."
      ],
      established: [
        "After all this time you STILL do this. WATER.",
        "I have said this to you more times than I can count. WATER. NOW.",
        "This is basically tradition at this point, but I'm still not letting it slide. Drink something."
      ]
    }
  },
  food: {
    smug: {
      new: [
        "When's the last time you ate something that wasn't coffee?",
        "Small suggestion: food. Just putting it out there.",
        "Your stomach called. It has notes."
      ],
      familiar: [
        "This is starting to feel like a pattern. Have you eaten?",
        "Round two of me asking if you've eaten today.",
        "You know I'm going to keep asking, right? Food."
      ],
      established: [
        "You always do this — skip meals and hope I won't notice. I notice.",
        "At this point I basically know your meal-skipping schedule better than you do.",
        "We both know what happens if I don't say something. Eat."
      ]
    },
    judging: {
      new: [
        "Running on fumes and vibes, I see.",
        "Still haven't eaten. Cool, cool, very sustainable.",
        "I'm not saying you forgot to eat, I'm just... implying it."
      ],
      familiar: [
        "This is the part where you pretend surprise that I noticed.",
        "Second reminder. You know how this usually goes from here.",
        "We're doing the ignoring-food thing again, I see."
      ],
      established: [
        "Classic you. Skip a meal, wait for me to say something, act surprised anyway.",
        "I could write a book on your relationship with meals at this point.",
        "You always push it this far before eating. Always."
      ]
    },
    angry: {
      new: [
        "Okay this is a food emergency. Go eat something.",
        "I refuse to keep watching you skip meals in silence.",
        "Eating is not optional, despite what your schedule suggests."
      ],
      familiar: [
        "This happens more than either of us would like to admit. Eat something.",
        "We've been here before and it always ends the same way — you finally eating. Let's skip ahead.",
        "I know exactly how this goes by now. Food. Now."
      ],
      established: [
        "After everything, you STILL let it get this far. Eat. Now.",
        "I've watched you do this so many times I could predict it. FOOD.",
        "This is basically our routine now, and I still hate it every time. Eat something."
      ]
    }
  },
  break: {
    smug: {
      new: [
        "You've been at this a while. Eyes still working okay?",
        "Small stretch break? Your spine would appreciate it.",
        "Just checking — you do remember you have a neck, right?"
      ],
      familiar: [
        "You're doing the marathon-sitting thing again.",
        "This is becoming a bit of a pattern, the not-moving thing.",
        "Break time. You know the drill by now."
      ],
      established: [
        "You always push it this long before moving. Always.",
        "At this point I basically know your sitting limit better than you do.",
        "We both know you're not going to stand up until I say something. So: stand up."
      ]
    },
    judging: {
      new: [
        "You've been hunched over that screen for a genuinely concerning amount of time.",
        "I'm starting to worry you've fused with the chair.",
        "This is your sign to stand up. The sign is me."
      ],
      familiar: [
        "This is at least the second time this week I've had to say this.",
        "You're doing the thing again where you just... don't move.",
        "I see we're back to ignoring your own spine."
      ],
      established: [
        "This happens basically every time you're deep in something. Every time.",
        "I've genuinely lost count of how many times I've had to remind you to move.",
        "You always do this — sit until I say something. Every single time."
      ]
    },
    angry: {
      new: [
        "STAND UP. Just for a second. I'm serious.",
        "Your posture has filed a formal complaint.",
        "I will keep interrupting you until you take five minutes."
      ],
      familiar: [
        "We both know how this goes — you eventually get up. Let's skip to that part. STAND UP.",
        "This is officially a repeat offense. Get up.",
        "I'm not letting this slide again. Move."
      ],
      established: [
        "After all this time, you still let it get this bad. STAND UP.",
        "This is basically a running theme with you. STAND UP. NOW.",
        "I've said this to you more times than I can count and I'm still saying it: MOVE."
      ]
    }
  },
  entertainment: {
    smug: [
      "Long watch session, huh? No judgement. Some judgement.",
      "Just checking in. Your to-do list also exists, by the way.",
      "This is a great video, I'm sure. So was the last one."
    ],
    judging: [
      "We're deep into the recommended-for-you pipeline now.",
      "Autoplay has fully taken the wheel and you've let it.",
      "Genuine question: was this the plan for tonight?"
    ],
    angry: [
      "Okay, that's a LOT of watching. Go check your list.",
      "I'm cutting in. Take a break from the screen for five minutes.",
      "The algorithm is winning and I refuse to watch it happen."
    ]
  },
  pomodoro: {
    break_start: [
      "Timer's up! Nice focus session. Go dance it off.",
      "25 minutes down. You earned this break.",
      "Break time! Stretch, hydrate, whatever you need."
    ]
  },
  debugSupport: {
    worried: [
      "You've been at this a long time. You okay over there?",
      "This has been a marathon coding session. Remember to breathe.",
      "Long one, huh. I believe in you — but also, maybe stand up for a sec?"
    ]
  },
  distraction: {
    smug: [
      "Noticed some back-and-forth with that other tab. Everything okay?",
      "Bouncing around a bit! No judgment, just checking in.",
      "That's a lot of tab-switching. Your focus called, it misses you."
    ]
  },
  battery: {
    warn: {
      new: [
        "Your battery's getting low. Might want to plug in soon.",
        "20%-ish left over here. Just a heads up.",
        "Charger o'clock, probably."
      ],
      familiar: [
        "This is becoming a familiar warning. Battery's low again.",
        "You know this one by now — battery's getting low.",
        "Same warning as usual: charge up soon."
      ],
      established: [
        "You always let it get this low before plugging in. Always.",
        "At this point I could predict your battery habits with scary accuracy.",
        "We both know you're going to wait until it's critical. Please don't."
      ]
    },
    angry: {
      new: [
        "We are about to lose power and you're just letting it happen.",
        "I can see the charger from here. So can you.",
        "This is the last warning before we both go dark."
      ],
      familiar: [
        "This is at least the second time this week we've been here. Plug in.",
        "You always cut it this close. Every time.",
        "We both know how this movie ends if you don't plug in."
      ],
      established: [
        "After everything, you STILL let it get this critical. Every single time.",
        "This is basically tradition with you and battery percentage. PLUG IN.",
        "I've watched this exact scenario play out more times than I'd like. Charge. Now."
      ]
    }
  },
  sleep: {
    late: {
      new: [
        "It's late. Not judging, just... noting.",
        "Whatever this is, it can probably wait until tomorrow.",
        "Getting kind of sleepy over here. You too, maybe?"
      ],
      familiar: [
        "This is becoming a familiar hour for you to still be up.",
        "You know this reminder by now — it's late.",
        "We're doing the late-night thing again, I see."
      ],
      established: [
        "You're always up around this time, aren't you.",
        "At this point I basically expect to see you up this late.",
        "This has become something of a routine for us, hasn't it. It's late."
      ]
    },
    deep: {
      new: [
        "...",
        "zzz...",
        "Still up, huh. I'll just be here, resting my eyes."
      ],
      familiar: [
        "...",
        "zzz... you again, huh...",
        "Still up. Of course you are."
      ],
      established: [
        "...",
        "zzz... some things never change, huh...",
        "Still up. At this point I'd be more surprised if you weren't."
      ]
    }
  },
  // Chapter 41B: study_start/study_end/project_start/project_end. These
  // don't have an escalation-tier concept the way nags do (no
  // smug/judging/angry ladder makes sense for "starting a study
  // session"), so each uses a single fixed 'default' level wrapping the
  // stage pools — same two-level nesting shape as water/food/etc, just
  // with one level name instead of three, so pickLine(category, level,
  // stage) needs zero changes to select from these correctly.
  //
  // project_start/project_end lines contain a literal "{label}" token —
  // main.js does a plain string replace after picking the line, since
  // pickLine's contract is "return one of these strings," not templating.
  study_start: {
    default: {
      new: [
        "Study time! I'll be quiet and let you focus.",
        "Starting a study session — go get it.",
        "Alright, focus mode. I'll hang back."
      ],
      familiar: [
        "Another study session — you've got this.",
        "Back at it. I'll keep to my corner.",
        "Study time again. I know the drill by now."
      ],
      established: [
        "You study a lot, don't you. I like that about you. Go get it.",
        "Another one of these — I'm honestly kind of proud of you at this point.",
        "We've done this so many times. Still rooting for you every time."
      ]
    }
  },
  study_end: {
    default: {
      new: [
        "Nice work! Hope that was a good session.",
        "Study session done. Take a breather.",
        "That's a wrap. Well done."
      ],
      familiar: [
        "Another solid session in the books.",
        "Done again! You're building a real habit here.",
        "Nice — that's becoming a regular thing for you."
      ],
      established: [
        "You always come through on these. Every time.",
        "At this point I've lost count of how many study sessions we've done together.",
        "Another one done. Honestly, I'm impressed by how consistent you are."
      ]
    }
  },
  project_start: {
    default: {
      new: [
        'Starting "{label}" — I\'ll stay out of your way.',
        "New project session: {label}. Let's go.",
        'Tracking "{label}" now. Good luck!'
      ],
      familiar: [
        'Back to "{label}"? Let\'s get going.',
        "Another session on {label} — you've got this.",
        'Picking "{label}" back up, noted.'
      ],
      established: [
        '"{label}" again — this one\'s really become a thing for you.',
        "You keep coming back to {label}. I respect the dedication.",
        "Another round with {label}. I'm rooting for you on this one."
      ]
    }
  },
  project_end: {
    default: {
      new: [
        'Nice work on "{label}".',
        "Session on {label} logged. Good stuff.",
        'Done with that {label} session — take a break.'
      ],
      familiar: [
        "Another good chunk of time on {label}.",
        '"{label}" session logged. You\'re making real progress.',
        "That's another one for {label}, nicely done."
      ],
      established: [
        "You've really put the hours into {label}, haven't you.",
        'Another {label} session in the books — you\'re all over this one.',
        "I've watched you chip away at {label} for a while now. It shows."
      ]
    }
  },
  resolved: [
    "There we go. Look at you, taking care of things.",
    "Proud of you. Genuinely.",
    "See, that wasn't so hard.",
    "Okay, back to normal. Nicely done."
  ]
};

// stage is optional — categories/levels that are still flat arrays (the
// ones untouched by Chapter 46) ignore it entirely and behave exactly as
// before. For the five stage-keyed categories, a missing/unrecognized
// stage falls back to 'new' rather than throwing, so a caller that
// forgets to pass one degrades to the original behavior instead of
// breaking.
function pickLine(category, level, stage) {
  const entry = lines[category];
  let pool = Array.isArray(entry) ? entry : entry && entry[level];
  if (pool && !Array.isArray(pool)) {
    pool = pool[stage] || pool.new || Object.values(pool)[0];
  }
  if (!pool || !pool.length) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { lines, pickLine };
