window.JNJ = {
 "meta": {
  "note": "SAMPLE DATA: synthetic, for design prototypes only. Model prices illustrative; Jev $0.042 per million input tokens.",
  "workflow": "How hard is this coding prompt? trivial / ordinary / hard; code maps to Haiku / Sonnet / Opus",
  "arms": {
   "A": "What you do now (always Sonnet)",
   "B": "A simple rule (under 32 characters goes to Haiku, else Sonnet)",
   "C": "Jev decides (difficulty to model; below 0.60 confidence falls back to Sonnet)"
  }
 },
 "cases": [
  {
   "id": "c01",
   "prompt": "Rename a variable across one file",
   "true_difficulty": "trivial",
   "tokens_in": 1263,
   "tokens_out": 304,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.008349,
     "label": "accept"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.008349,
     "label": "accept"
    },
    "C": {
     "picked": "haiku",
     "jev_answer": "trivial",
     "jev_confidence": 0.83,
     "fallback": false,
     "picker_cost": 8.06e-06,
     "cost": 0.002791,
     "label": "accept"
    }
   }
  },
  {
   "id": "c02",
   "prompt": "Write a regex for UK postcodes",
   "true_difficulty": "trivial",
   "tokens_in": 748,
   "tokens_out": 698,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.012714,
     "label": "accept"
    },
    "B": {
     "picked": "haiku",
     "cost": 0.004238,
     "label": "accept"
    },
    "C": {
     "picked": "haiku",
     "jev_answer": "trivial",
     "jev_confidence": 0.75,
     "fallback": false,
     "picker_cost": 1.382e-05,
     "cost": 0.004252,
     "label": "accept"
    }
   }
  },
  {
   "id": "c03",
   "prompt": "Fix a typo in a README",
   "true_difficulty": "trivial",
   "tokens_in": 718,
   "tokens_out": 669,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.012189,
     "label": "accept"
    },
    "B": {
     "picked": "haiku",
     "cost": 0.004063,
     "label": "accept"
    },
    "C": {
     "picked": "haiku",
     "jev_answer": "trivial",
     "jev_confidence": 0.78,
     "fallback": false,
     "picker_cost": 8.48e-06,
     "cost": 0.004071,
     "label": "accept"
    }
   }
  },
  {
   "id": "c04",
   "prompt": "Add a unit test for a pure function",
   "true_difficulty": "ordinary",
   "tokens_in": 1488,
   "tokens_out": 578,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.013134,
     "label": "accept"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.013134,
     "label": "accept"
    },
    "C": {
     "picked": "sonnet",
     "jev_answer": "ordinary",
     "jev_confidence": 0.74,
     "fallback": false,
     "picker_cost": 8.53e-06,
     "cost": 0.013143,
     "label": "accept"
    }
   }
  },
  {
   "id": "c05",
   "prompt": "Convert a callback to async/await",
   "true_difficulty": "ordinary",
   "tokens_in": 1728,
   "tokens_out": 584,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.013944,
     "label": "accept"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.013944,
     "label": "accept"
    },
    "C": {
     "picked": "sonnet",
     "jev_answer": "ordinary",
     "jev_confidence": 0.74,
     "fallback": false,
     "picker_cost": 1.361e-05,
     "cost": 0.013958,
     "label": "accept"
    }
   }
  },
  {
   "id": "c06",
   "prompt": "Explain a failing CI log",
   "true_difficulty": "ordinary",
   "tokens_in": 853,
   "tokens_out": 378,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.008229,
     "label": "accept"
    },
    "B": {
     "picked": "haiku",
     "cost": 0.002743,
     "label": "reject"
    },
    "C": {
     "picked": "sonnet",
     "jev_answer": "ordinary",
     "jev_confidence": 0.89,
     "fallback": false,
     "picker_cost": 1.382e-05,
     "cost": 0.008243,
     "label": "accept"
    }
   }
  },
  {
   "id": "c07",
   "prompt": "Write a SQL query with a window function",
   "true_difficulty": "ordinary",
   "tokens_in": 726,
   "tokens_out": 740,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.013278,
     "label": "accept"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.013278,
     "label": "accept"
    },
    "C": {
     "picked": "sonnet",
     "jev_answer": "ordinary",
     "jev_confidence": 0.88,
     "fallback": false,
     "picker_cost": 8.06e-06,
     "cost": 0.013286,
     "label": "accept"
    }
   }
  },
  {
   "id": "c08",
   "prompt": "Refactor a 300-line React component",
   "true_difficulty": "hard",
   "tokens_in": 1052,
   "tokens_out": 197,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.006111,
     "label": "reject"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.006111,
     "label": "reject"
    },
    "C": {
     "picked": "opus",
     "jev_answer": "hard",
     "jev_confidence": 0.87,
     "fallback": false,
     "picker_cost": 8.99e-06,
     "cost": 0.008157,
     "label": "accept"
    }
   }
  },
  {
   "id": "c09",
   "prompt": "Design a retry policy for a flaky API",
   "true_difficulty": "hard",
   "tokens_in": 1193,
   "tokens_out": 579,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.012264,
     "label": "reject"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.012264,
     "label": "reject"
    },
    "C": {
     "picked": "opus",
     "jev_answer": "hard",
     "jev_confidence": 0.76,
     "fallback": false,
     "picker_cost": 8.82e-06,
     "cost": 0.016361,
     "label": "accept"
    }
   }
  },
  {
   "id": "c10",
   "prompt": "Find a race condition in a worker pool",
   "true_difficulty": "hard",
   "tokens_in": 1769,
   "tokens_out": 465,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.012282,
     "label": "reject"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.012282,
     "label": "reject"
    },
    "C": {
     "picked": "sonnet",
     "jev_answer": "ordinary",
     "jev_confidence": 0.93,
     "fallback": false,
     "picker_cost": 1.487e-05,
     "cost": 0.012297,
     "label": "reject"
    }
   }
  },
  {
   "id": "c11",
   "prompt": "Format a JSON file",
   "true_difficulty": "trivial",
   "tokens_in": 970,
   "tokens_out": 255,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.006735,
     "label": "accept"
    },
    "B": {
     "picked": "haiku",
     "cost": 0.002245,
     "label": "accept"
    },
    "C": {
     "picked": "haiku",
     "jev_answer": "trivial",
     "jev_confidence": 0.88,
     "fallback": false,
     "picker_cost": 1.441e-05,
     "cost": 0.002259,
     "label": "accept"
    }
   }
  },
  {
   "id": "c12",
   "prompt": "Add input validation to an endpoint",
   "true_difficulty": "ordinary",
   "tokens_in": 984,
   "tokens_out": 531,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.010917,
     "label": "accept"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.010917,
     "label": "accept"
    },
    "C": {
     "picked": "sonnet",
     "jev_answer": "ordinary",
     "jev_confidence": 0.75,
     "fallback": false,
     "picker_cost": 1.52e-05,
     "cost": 0.010932,
     "label": "accept"
    }
   }
  },
  {
   "id": "c13",
   "prompt": "Write a git command to split a commit",
   "true_difficulty": "ordinary",
   "tokens_in": 728,
   "tokens_out": 727,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.013089,
     "label": "accept"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.013089,
     "label": "accept"
    },
    "C": {
     "picked": "sonnet",
     "jev_answer": "ordinary",
     "jev_confidence": 0.74,
     "fallback": false,
     "picker_cost": 9.74e-06,
     "cost": 0.013099,
     "label": "accept"
    }
   }
  },
  {
   "id": "c14",
   "prompt": "Summarise a stack trace",
   "true_difficulty": "trivial",
   "tokens_in": 1616,
   "tokens_out": 846,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.017538,
     "label": "accept"
    },
    "B": {
     "picked": "haiku",
     "cost": 0.005846,
     "label": "accept"
    },
    "C": {
     "picked": "haiku",
     "jev_answer": "trivial",
     "jev_confidence": 0.86,
     "fallback": false,
     "picker_cost": 1.588e-05,
     "cost": 0.005862,
     "label": "accept"
    }
   }
  },
  {
   "id": "c15",
   "prompt": "Plan a database migration with zero downtime",
   "true_difficulty": "hard",
   "tokens_in": 1243,
   "tokens_out": 626,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.013119,
     "label": "reject"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.013119,
     "label": "reject"
    },
    "C": {
     "picked": "opus",
     "jev_answer": "hard",
     "jev_confidence": 0.88,
     "fallback": false,
     "picker_cost": 1.243e-05,
     "cost": 0.017504,
     "label": "accept"
    }
   }
  },
  {
   "id": "c16",
   "prompt": "Add dark mode tokens to a stylesheet",
   "true_difficulty": "ordinary",
   "tokens_in": 1340,
   "tokens_out": 456,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.01086,
     "label": "accept"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.01086,
     "label": "accept"
    },
    "C": {
     "picked": "sonnet",
     "jev_answer": "ordinary",
     "jev_confidence": 0.79,
     "fallback": false,
     "picker_cost": 9.49e-06,
     "cost": 0.010869,
     "label": "accept"
    }
   }
  },
  {
   "id": "c17",
   "prompt": "Sort imports in a module",
   "true_difficulty": "trivial",
   "tokens_in": 2031,
   "tokens_out": 399,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.012078,
     "label": "accept"
    },
    "B": {
     "picked": "haiku",
     "cost": 0.004026,
     "label": "accept"
    },
    "C": {
     "picked": "haiku",
     "jev_answer": "trivial",
     "jev_confidence": 0.74,
     "fallback": false,
     "picker_cost": 1.075e-05,
     "cost": 0.004037,
     "label": "accept"
    }
   }
  },
  {
   "id": "c18",
   "prompt": "Debug a memory leak in a Node service",
   "true_difficulty": "hard",
   "tokens_in": 1675,
   "tokens_out": 656,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.014865,
     "label": "reject"
    },
    "B": {
     "picked": "sonnet",
     "cost": 0.014865,
     "label": "reject"
    },
    "C": {
     "picked": "sonnet",
     "jev_answer": "ordinary",
     "jev_confidence": 0.58,
     "fallback": true,
     "picker_cost": 1.537e-05,
     "cost": 0.01488,
     "label": "reject"
    }
   }
  },
  {
   "id": "c19",
   "prompt": "Write a Dockerfile healthcheck",
   "true_difficulty": "ordinary",
   "tokens_in": 1519,
   "tokens_out": 444,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.011217,
     "label": "accept"
    },
    "B": {
     "picked": "haiku",
     "cost": 0.003739,
     "label": "reject"
    },
    "C": {
     "picked": "sonnet",
     "jev_answer": "ordinary",
     "jev_confidence": 0.88,
     "fallback": false,
     "picker_cost": 8.32e-06,
     "cost": 0.011225,
     "label": "accept"
    }
   }
  },
  {
   "id": "c20",
   "prompt": "Rename a CSS class everywhere",
   "true_difficulty": "trivial",
   "tokens_in": 841,
   "tokens_out": 674,
   "arms": {
    "A": {
     "picked": "sonnet",
     "cost": 0.012633,
     "label": "accept"
    },
    "B": {
     "picked": "haiku",
     "cost": 0.004211,
     "label": "accept"
    },
    "C": {
     "picked": "haiku",
     "jev_answer": "trivial",
     "jev_confidence": 0.83,
     "fallback": false,
     "picker_cost": 1.567e-05,
     "cost": 0.004227,
     "label": "accept"
    }
   }
  }
 ],
 "summary": {
  "A": {
   "spend": 0.235545,
   "kept": 15,
   "cpk": 0.015703
  },
  "B": {
   "spend": 0.173323,
   "kept": 13,
   "cpk": 0.013333
  },
  "C": {
   "spend": 0.191453,
   "kept": 18,
   "cpk": 0.010636
  }
 },
 "jev_vs": {
  "A": {
   "wins": 3,
   "losses": 0
  },
  "B": {
   "wins": 5,
   "losses": 0
  }
 },
 "verdict": {
  "result": "use_jev",
  "rule": 3
 },
 "benchmark": {
  "items": 90,
  "one_call": {
   "jev": {
    "s": 0.4,
    "usd": 0.0006,
    "correct": 86
   },
   "haiku": {
    "s": 93.0,
    "usd": 0.0629,
    "correct": 87
   },
   "sonnet": {
    "s": 52.6,
    "usd": 0.0901,
    "correct": 86
   },
   "opus": {
    "s": 17.3,
    "usd": 0.1047,
    "correct": 88
   }
  }
 },
 "use_cases": [
  [
   "UC1",
   "Scope guard",
   "Does the change stay within the request?"
  ],
  [
   "UC2",
   "Check-failure triage",
   "This change, dependency, flaky or config?"
  ],
  [
   "UC3",
   "Evidence grader",
   "Verified, inferred or unverified?"
  ],
  [
   "UC4",
   "Autonomy gate",
   "Continue alone or ask the operator?"
  ],
  [
   "UC5",
   "Repeat-question detector",
   "Asked before?"
  ],
  [
   "UC6",
   "Request completeness",
   "Complete or missing a field?"
  ],
  [
   "UC7",
   "Client message routing",
   "Data, question, change or other?"
  ],
  [
   "UC8",
   "PR description check",
   "Matches, overstates or understates?"
  ],
  [
   "UC9",
   "Website slop roast",
   "Ten slop checks, scored by code"
  ],
  [
   "UC10",
   "Tech stack choice",
   "Which properties does the project need?"
  ]
 ],
 "ask_examples": [
  {
   "q": "Should I use Jev to write my blog posts?",
   "mark": "Jev probably not",
   "why": "Open writing has no fixed answers",
   "instead": "Is this draft ready to publish? yes / no"
  },
  {
   "q": "Should I use Jev to route support tickets?",
   "mark": "Jev could help",
   "why": "Fixed categories, text in, volume",
   "rule": "keyword list"
  },
  {
   "q": "Should I use Jev to decide if my agent should continue?",
   "mark": "Jev could help",
   "why": "Two answers, every turn, cheap",
   "rule": "list of outward actions"
  }
 ]
};
