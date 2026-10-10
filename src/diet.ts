// Diet tags are enforced only where Places data can check them (spec section 6 table).

type PlaceLike = { cuisine: string; primaryType: string; types: string[]; servesVegetarianFood?: boolean; name: string };

const SEAFOOD_TYPES = ["seafood_restaurant", "sushi_restaurant"];
const MEAT_HEAVY = ["steak_house", "barbecue_restaurant", "seafood_restaurant"];

/** Tags the coordinator can turn into a filter. Others are stored and only exclude cuisines the user named. */
export const CHECKABLE_TAGS = ["vegetarian", "vegan", "no seafood", "no shellfish", "pescatarian"];

export function dietOk(place: PlaceLike, tags: string[]): boolean {
  const types = new Set([place.primaryType, ...place.types]);
  for (const raw of tags) {
    const tag = raw.toLowerCase().trim();
    switch (tag) {
      case "vegetarian":
        if (place.servesVegetarianFood === false) return false;
        break;
      case "vegan":
        if (place.servesVegetarianFood === false || MEAT_HEAVY.some((t) => types.has(t))) return false;
        break;
      case "pescatarian":
        if (place.servesVegetarianFood === false && !SEAFOOD_TYPES.some((t) => types.has(t))) return false;
        break;
      case "no seafood":
        if (SEAFOOD_TYPES.some((t) => types.has(t))) return false;
        break;
      case "no shellfish":
        if (types.has("seafood_restaurant")) return false;
        break;
      default: {
        // "no ramen" style tags exclude a cuisine the user named.
        const m = tag.match(/^no (.+)$/);
        if (m) {
          const x = m[1]!;
          if (place.cuisine.toLowerCase() === x || place.primaryType.startsWith(x.replace(/\s+/g, "_"))) return false;
        }
      }
    }
  }
  return true;
}

/** Does a veto/dislike target match this place? */
export function matchesTarget(target: string, place: { placeId: string; name: string; cuisine: string; primaryType?: string }): boolean {
  const t = target.toLowerCase().trim();
  if (!t) return false;
  if (place.placeId === target) return true;
  const singular = t.replace(/s$/, "");
  const cuisine = place.cuisine.toLowerCase();
  return (
    cuisine === t ||
    cuisine === singular ||
    cuisine.replace(/s$/, "") === singular ||
    place.name.toLowerCase().includes(singular) ||
    (place.primaryType ?? "").startsWith(singular.replace(/\s+/g, "_"))
  );
}
