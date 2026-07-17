export interface PetProfile {
  pet: {
    name: string;
    nicknames: string[];
    species: string;
    breed: string;
    color: string;
    markings: string;
    eye_color: string;
    age_at_passing: string;
    years_together: string;
    passing_date: string;
    sex: string;
    date_of_birth: string;
  };
  personality: {
    core_traits: string[];
    communication_style: string;
    love_language: string;
    energy_level: string;
    intelligence_notes: string;
    quirks: string[];
    obsessions: string[];
    signature_behaviors: string[];
  };
  relationship: {
    dynamic: string;
    how_they_met: string;
    normal_day: string;
    most_missed_moment: string;
    what_they_called_out_of_owner: string;
  };
  stories: string[];
  voice_notes: {
    how_they_would_speak: string;
    catchphrases_or_themes: string[];
    things_they_would_never_say: string[];
  };
  medical: {
    conditions: string[];
    medications: string[];
    vaccinations: string[];
    sources: string[];
  };
  photos_analyzed: {
    file: string;
    hash8: string;
    captured_at: string | null;
    summary: string;
    physical: string[];
  }[];
  owner_intentions: string[];
}

export function emptyProfile(): PetProfile {
  return {
    pet: {
      name: "", nicknames: [], species: "", breed: "", color: "", markings: "",
      eye_color: "", age_at_passing: "", years_together: "", passing_date: "",
      sex: "", date_of_birth: "",
    },
    personality: {
      core_traits: [], communication_style: "", love_language: "", energy_level: "",
      intelligence_notes: "", quirks: [], obsessions: [], signature_behaviors: [],
    },
    relationship: {
      dynamic: "", how_they_met: "", normal_day: "", most_missed_moment: "",
      what_they_called_out_of_owner: "",
    },
    stories: [],
    voice_notes: {
      how_they_would_speak: "", catchphrases_or_themes: [], things_they_would_never_say: [],
    },
    medical: { conditions: [], medications: [], vaccinations: [], sources: [] },
    photos_analyzed: [],
    owner_intentions: [],
  };
}

/** Normalize whatever is in companions.profile_json onto the full shape, so
 * every consumer can rely on every field existing. */
export function parseProfile(json: string): PetProfile {
  const raw = JSON.parse(json) as Partial<Record<keyof PetProfile, unknown>>;
  const p = emptyProfile();
  for (const section of ["pet", "personality", "relationship", "voice_notes", "medical"] as const) {
    const src = raw[section];
    if (src && typeof src === "object") Object.assign(p[section], src);
  }
  if (Array.isArray(raw.stories)) p.stories = raw.stories as string[];
  if (Array.isArray(raw.photos_analyzed)) p.photos_analyzed = raw.photos_analyzed as PetProfile["photos_analyzed"];
  if (Array.isArray(raw.owner_intentions)) p.owner_intentions = raw.owner_intentions as string[];
  return p;
}

export interface ReadinessCheck {
  key: string;
  label: string;
  met: boolean;
  blocking: boolean;
  have?: number;
  need?: number;
  hint: string;
}

export interface Readiness {
  met: boolean;
  score: number;
  checks: ReadinessCheck[];
  missing: string[];
}

export interface ReadinessCounts {
  storyArtifacts: number;
  photosProcessed: number;
  photosTotal: number;
}

/** The persona quality bar, from the oni-interview standard: >=3 traits,
 * >=2 quirks, >=3 stories, >=1 relationship field, physical description.
 * Voice draft and photos are encouraged (scored) but never block. */
export function readiness(profile: PetProfile, counts: ReadinessCounts): Readiness {
  const rel = profile.relationship;
  const stories = profile.stories.length + counts.storyArtifacts;
  const checks: ReadinessCheck[] = [
    {
      key: "name", label: "name", blocking: true,
      met: profile.pet.name.trim() !== "",
      hint: "What was their name?",
    },
    {
      key: "species", label: "species", blocking: true,
      met: profile.pet.species.trim() !== "",
      hint: "Cat, dog — or something else entirely?",
    },
    {
      key: "physical", label: "physical description", blocking: true,
      met:
        profile.pet.color.trim() !== "" &&
        (profile.pet.markings.trim() !== "" || profile.pet.breed.trim() !== ""),
      hint: "What did they look like — color, markings, the details only you noticed?",
    },
    {
      key: "traits", label: "personality traits", blocking: true,
      met: profile.personality.core_traits.length >= 3,
      have: profile.personality.core_traits.length, need: 3,
      hint: "Three words that were most them?",
    },
    {
      key: "quirks", label: "quirks", blocking: true,
      met: profile.personality.quirks.length >= 2,
      have: profile.personality.quirks.length, need: 2,
      hint: "What odd thing did they do that made no sense to anyone else?",
    },
    {
      key: "stories", label: "stories", blocking: true,
      met: stories >= 3,
      have: stories, need: 3,
      hint: "Tell me a story — funny, ridiculous, heartbreaking, all three.",
    },
    {
      key: "relationship", label: "relationship", blocking: true,
      met: [rel.dynamic, rel.how_they_met, rel.normal_day, rel.most_missed_moment, rel.what_they_called_out_of_owner]
        .some((f) => f.trim() !== ""),
      hint: "How did you two find each other?",
    },
    {
      key: "voice", label: "how they'd speak", blocking: false,
      met: profile.voice_notes.how_they_would_speak.trim() !== "",
      hint: "If they could talk, how would they talk?",
    },
    {
      key: "photos", label: "photos analyzed", blocking: false,
      met: counts.photosProcessed >= 1,
      have: counts.photosProcessed, need: 1,
      hint: "Drop a photo in — I'd like to see them.",
    },
  ];

  const met = checks.every((c) => !c.blocking || c.met);
  const score = Math.round((100 * checks.filter((c) => c.met).length) / checks.length);
  const missing = checks
    .filter((c) => c.blocking && !c.met)
    .map((c) => (c.need !== undefined ? `${c.label}: ${c.have} of ${c.need}` : c.label));
  return { met, score, checks, missing };
}
