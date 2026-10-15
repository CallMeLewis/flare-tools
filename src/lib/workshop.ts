import type { Visibility } from "@/lib/api";

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  public: "Public",
  friendsOnly: "Friends only",
  unlisted: "Unlisted",
  private: "Private",
};

export const VISIBILITY_DESCRIPTION: Record<Visibility, string> = {
  public: "Anyone can find and subscribe to it.",
  friendsOnly: "Only your Steam friends can see it.",
  unlisted: "Anyone with the link can see it, but it isn't listed.",
  private: "Only you can see it.",
};

/** The tags DayZ's Workshop filters by, grouped as the Workshop page groups them. */
export const TAG_GROUPS: { name: string; tags: string[] }[] = [
  { name: "Type", tags: ["Mod", "Server"] },
  {
    name: "Mod type",
    tags: ["Animation", "Character", "Economy", "Environment", "Equipment", "Mechanics", "Props", "Sound", "Terrain", "Vehicle", "Weapon"],
  },
  { name: "Meta", tags: ["Dependency", "Collection"] },
];

/** Steam's limits, in bytes, as the backend checks them. Text is measured with textBytes. */
export const LIMITS = {
  title: 128,
  description: 7999,
  changeNote: 7999,
  previewBytes: 1024 * 1024,
};

const encoder = new TextEncoder();

/** Text's size as Steam measures it against its limits: in UTF-8, where some characters take two to four bytes. */
export function textBytes(value: string): number {
  return encoder.encode(value).length;
}
