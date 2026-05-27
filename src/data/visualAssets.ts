import type { FurnitureDefinition } from "../components/types";
import furnitureAtlas from "../assets/atlases/furniture.json";

export type VisualAtlasKey = "furniture" | "characters" | "environment" | "ui-icons";
export type CharacterVisualRole = "guest" | "waiter" | "chef" | "errand";
export type CharacterVisualAction = "idle" | "walk" | "sit" | "carry" | "serve" | "clean" | "cook";
export type CharacterVisualFacing =
  | "down"
  | "up"
  | "left"
  | "right"
  | "down-right"
  | "down-left"
  | "up-right"
  | "up-left";
export type VisualHeightClass = "floor" | "low" | "seat" | "table" | "counter" | "tall" | "wall";

export const characterVariantCount = 6;

export interface SpriteAnchor {
  x: number;
  y: number;
}

export interface SpritePoint {
  x: number;
  y: number;
}

export interface FurnitureFrameMetadata {
  sourceSize: { w: number; h: number };
  anchorPx?: SpritePoint;
  seatSurfacePx?: SpritePoint[];
  tableServicePx?: SpritePoint[];
}

export interface FurnitureSpriteVisual {
  atlas: "furniture";
  frameBase: string;
  origin: SpriteAnchor;
  xOffset: number;
  yOffset: number;
  scale: number;
  sourceScale: number;
  heightClass: VisualHeightClass;
}

export interface CharacterSpriteVisual {
  atlas: "characters";
  frame: string;
  origin: SpriteAnchor;
  xOffset: number;
  yOffset: number;
  scale: number;
}

const furnitureHeightClasses: Record<FurnitureDefinition["category"], VisualHeightClass> = {
  table: "table",
  chair: "seat",
  stove: "counter",
  counter: "counter",
  decoration: "low",
  plant: "tall",
  wallDecoration: "wall",
  lighting: "tall",
  flooring: "floor",
};

const furnitureAtlasSourceScale = 2;
const furnitureAtlasFrames = (furnitureAtlas as { frames: Record<string, FurnitureFrameMetadata> }).frames;

export function getFurnitureSpriteVisual(definition: FurnitureDefinition): FurnitureSpriteVisual {
  const heightClass = furnitureHeightClasses[definition.category] ?? "low";
  const isFloor = definition.category === "flooring";
  const isFloorTextile = definition.category === "decoration" && /rug|mat|carpet/.test(definition.id);
  const isBenchSeat = definition.id === "bench-seat";
  const scaleByCategory: Record<FurnitureDefinition["category"], number> = {
    table: 0.8,
    chair: isBenchSeat ? 0.86 : 0.72,
    stove: 0.9,
    counter: 0.9,
    decoration: isFloorTextile ? 0.96 : 0.86,
    plant: 0.8,
    wallDecoration: 1,
    lighting: 0.86,
    flooring: 1,
  };

  return {
    atlas: "furniture",
    frameBase: definition.id,
    origin: { x: 0.5, y: 0.5 },
    xOffset: 0,
    yOffset: 0,
    scale: scaleByCategory[definition.category] / furnitureAtlasSourceScale,
    sourceScale: furnitureAtlasSourceScale,
    heightClass,
  };
}

export function getFurnitureSpriteFrame(definition: FurnitureDefinition, rotation: number): string {
  const normalizedRotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  return `${definition.id}-r${normalizedRotation}`;
}

export function getFurnitureFrameMetadata(frame: string): FurnitureFrameMetadata | null {
  return furnitureAtlasFrames[frame] ?? null;
}

export function getFurnitureSpriteOrigin(frame: string, fallback: SpriteAnchor = { x: 0.5, y: 0.5 }): SpriteAnchor {
  const metadata = getFurnitureFrameMetadata(frame);
  if (!metadata?.anchorPx || !metadata.sourceSize?.w || !metadata.sourceSize?.h) {
    return fallback;
  }

  return {
    x: metadata.anchorPx.x / metadata.sourceSize.w,
    y: metadata.anchorPx.y / metadata.sourceSize.h,
  };
}

export function getCharacterSpriteFrame(
  role: CharacterVisualRole,
  action: CharacterVisualAction,
  facing: CharacterVisualFacing,
  phase = 0,
  variant = 0,
): CharacterSpriteVisual {
  const walkFrame = Math.sin(phase) >= 0 ? 1 : 2;
  const frameAction = action === "walk" ? `walk-${walkFrame}` : action === "cook" ? `cook-${walkFrame}` : action;
  const normalizedVariant = ((Math.floor(variant) % characterVariantCount) + characterVariantCount) % characterVariantCount;
  const seated = action === "sit";
  // For seated sprites, anchor the sprite at the BUTT (not the feet) so the
  // butt lands at the chair seat point automatically. Butt is at ~55% from
  // the top of the seated AI art (head -> torso -> hips/butt -> bent legs ->
  // feet). For standing sprites, anchor at feet (origin y = 1) as usual.
  const originY = seated ? 0.55 : 1;
  return {
    atlas: "characters",
    frame: `${role}-${frameAction}-${facing}-v${normalizedVariant}`,
    origin: { x: 0.5, y: originY },
    xOffset: 0,
    yOffset: 6,
    // Seated AI art is drawn full-height (head to feet on floor) so at the
    // standing scale the character towers over the chair. Shrink seated
    // sprites so the seated silhouette is roughly chair-sized.
    scale: seated ? 0.40 : 0.52,
  };
}
