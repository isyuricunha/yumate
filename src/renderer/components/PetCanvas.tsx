import { useEffect, useMemo, useRef } from "react";
import {
  type BehaviorState,
  type DesktopPetMetadata,
  type InstalledPetPack,
  type PetAnimation,
  type TwoDPetMetadata,
  type TwoDPetMotion,
} from "../../shared/types";

interface PetCanvasProps {
  pack: InstalledPetPack;
  state: BehaviorState;
  scale: number;
  onClick: () => void;
}

export function PetCanvas({ pack, state, scale, onClick }: PetCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const desktopMetadataRef = useRef<DesktopPetMetadata | null>(pack.metadata);
  const twoDMetadataRef = useRef<TwoDPetMetadata | null>(pack.twoD);
  desktopMetadataRef.current = pack.metadata;
  twoDMetadataRef.current = pack.twoD;

  const assetPath = pack.twoDImagePath ?? pack.spritesheetPath;
  const petUrl = useMemo(() => toFileUrl(assetPath), [assetPath]);

  useEffect(() => {
    const image = new Image();
    image.src = petUrl;
    imageRef.current = image;
    return () => {
      imageRef.current = null;
    };
  }, [petUrl]);

  useEffect(() => {
    let frameId = 0;
    const startedAt = performance.now();

    const draw = (time: number) => {
      const canvas = canvasRef.current;
      const image = imageRef.current;
      if (!canvas || !image || !image.complete) {
        frameId = requestAnimationFrame(draw);
        return;
      }

      const context = canvas.getContext("2d");
      if (!context) {
        frameId = requestAnimationFrame(draw);
        return;
      }

      const elapsed = Math.max(0, time - startedAt) / 1000;
      const twoDMetadata = twoDMetadataRef.current;
      if (twoDMetadata) {
        drawTwoDPet(canvas, context, image, twoDMetadata, state, scale, elapsed);
      } else {
        drawSpritePet(canvas, context, image, desktopMetadataRef.current, state, scale, elapsed);
      }

      frameId = requestAnimationFrame(draw);
    };

    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [pack.metadata, pack.twoD, scale, state]);

  return (
    <canvas
      ref={canvasRef}
      className="pet-canvas"
      data-interactive="true"
      onPointerDown={(event) => {
        (event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId);
        dragRef.current = { x: event.screenX, y: event.screenY, moved: false };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) {
          return;
        }
        const delta = { x: event.screenX - drag.x, y: event.screenY - drag.y };
        if (Math.abs(delta.x) > 0 || Math.abs(delta.y) > 0) {
          drag.moved = true;
          drag.x = event.screenX;
          drag.y = event.screenY;
          void window.yumate.moveWindowBy(delta);
        }
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        void window.yumate.saveWindowPosition();
        if (!drag?.moved) {
          onClick();
        }
        (event.currentTarget as HTMLCanvasElement).releasePointerCapture(event.pointerId);
      }}
    />
  );
}

function drawSpritePet(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  metadataFromPack: DesktopPetMetadata | null,
  state: BehaviorState,
  scale: number,
  elapsedSeconds: number,
): void {
  const metadata = metadataFromPack ?? inferMetadata(image);
  const animationName = resolveAnimation(metadata, state);
  const animation = metadata.animations[animationName] ?? metadata.animations.idle ?? firstAnimation(metadata);
  if (!animation) {
    return;
  }

  const frameWidth = metadata.frameWidth;
  const frameHeight = metadata.frameHeight;
  const targetWidth = Math.round(frameWidth * scale);
  const targetHeight = Math.round(frameHeight * scale);
  setCanvasSize(canvas, targetWidth, targetHeight);

  const frame = getFrame(animation, elapsedSeconds);
  const sourceX = ((animation.startFrame ?? 0) + frame) * frameWidth;
  const sourceY = animation.row * frameHeight;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, sourceX, sourceY, frameWidth, frameHeight, 0, 0, targetWidth, targetHeight);
}

function drawTwoDPet(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  metadata: TwoDPetMetadata,
  state: BehaviorState,
  scale: number,
  elapsedSeconds: number,
): void {
  const motion = resolveTwoDMotion(metadata, state);
  const sourceWidth = metadata.width ?? image.naturalWidth;
  const sourceHeight = metadata.height ?? image.naturalHeight;
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  const motionPadding = Math.ceil(24 * scale + (motion.bobPixels ?? 0) * 2 * scale + targetHeight * (motion.breatheScale ?? 0));
  const canvasWidth = targetWidth + motionPadding * 2;
  const canvasHeight = targetHeight + motionPadding * 2;
  setCanvasSize(canvas, canvasWidth, canvasHeight);

  const bobSeconds = motion.bobSeconds ?? 2.8;
  const bob = Math.sin((elapsedSeconds / bobSeconds) * Math.PI * 2) * (motion.bobPixels ?? 6) * scale;
  const breathe = Math.sin((elapsedSeconds / (bobSeconds * 0.9)) * Math.PI * 2) * (motion.breatheScale ?? 0.025);
  const sway = Math.sin((elapsedSeconds / (bobSeconds * 1.15)) * Math.PI * 2) * (motion.swayDegrees ?? 1.2);
  const flip = state === "walking-left" ? -1 : 1;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.save();
  context.translate(canvas.width / 2, canvas.height / 2 + bob);
  context.rotate((sway * Math.PI) / 180);
  context.scale(flip * (1 + breathe * 0.35), 1 + breathe);
  context.drawImage(image, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
  context.restore();
}

function resolveTwoDMotion(metadata: TwoDPetMetadata, state: BehaviorState): Required<TwoDPetMotion> {
  const defaults = defaultTwoDMotion(state);
  const preset =
    metadata.stateMotions?.[state] ??
    (state === "speaking" || state === "reviewing" ? metadata.speakingMotion : metadata.idleMotion);

  return {
    ...defaults,
    ...preset,
  };
}

function defaultTwoDMotion(state: BehaviorState): Required<TwoDPetMotion> {
  if (state === "speaking" || state === "reviewing") {
    return { bobPixels: 5, bobSeconds: 1.2, breatheScale: 0.04, swayDegrees: 0.8 };
  }
  if (state === "thinking" || state === "processing") {
    return { bobPixels: 3, bobSeconds: 2.1, breatheScale: 0.018, swayDegrees: 0.6 };
  }
  if (state === "clicked") {
    return { bobPixels: 10, bobSeconds: 0.55, breatheScale: 0.035, swayDegrees: 3 };
  }
  if (state === "error") {
    return { bobPixels: 1, bobSeconds: 0.18, breatheScale: 0.01, swayDegrees: 4 };
  }
  return { bobPixels: 6, bobSeconds: 2.8, breatheScale: 0.025, swayDegrees: 1.2 };
}

function setCanvasSize(canvas: HTMLCanvasElement, width: number, height: number): void {
  if (canvas.width === width && canvas.height === height) {
    return;
  }

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

function inferMetadata(image: HTMLImageElement): DesktopPetMetadata {
  const codexMetadata = inferCodexOpenPetMetadata(image);
  if (codexMetadata) {
    return codexMetadata;
  }

  return {
    schemaVersion: 1,
    frameWidth: image.naturalWidth,
    frameHeight: image.naturalHeight,
    columns: 1,
    rows: 1,
    animations: {
      idle: { row: 0, frames: 1, fps: 1, loop: true },
    },
    stateMap: {
      idle: "idle",
    },
  };
}

function inferCodexOpenPetMetadata(image: HTMLImageElement): DesktopPetMetadata | null {
  const columns = 8;
  const rows = 9;
  if (image.naturalWidth % columns !== 0 || image.naturalHeight % rows !== 0) {
    return null;
  }

  const frameWidth = image.naturalWidth / columns;
  const frameHeight = image.naturalHeight / rows;
  if (frameWidth < 64 || frameHeight < 64) {
    return null;
  }

  return {
    schemaVersion: 1,
    frameWidth,
    frameHeight,
    columns,
    rows,
    animations: {
      idle: { row: 0, frames: 6, fps: 6, loop: true },
      "running-right": { row: 1, frames: 8, fps: 10, loop: true },
      "running-left": { row: 2, frames: 8, fps: 10, loop: true },
      waving: { row: 3, frames: 4, fps: 7, loop: true },
      jumping: { row: 4, frames: 5, fps: 9, loop: false, returnState: "idle" },
      failed: { row: 5, frames: 8, fps: 8, loop: true },
      waiting: { row: 6, frames: 6, fps: 5, loop: true },
      running: { row: 7, frames: 6, fps: 9, loop: true },
      review: { row: 8, frames: 6, fps: 6, loop: true },
    },
    stateMap: {
      idle: "idle",
      "walking-right": "running-right",
      "walking-left": "running-left",
      thinking: "waiting",
      processing: "running",
      reviewing: "review",
      speaking: "waving",
      clicked: "jumping",
      error: "failed",
    },
  };
}

function resolveAnimation(metadata: DesktopPetMetadata, state: BehaviorState): string {
  const mapped = metadata.stateMap[state];
  if (mapped && metadata.animations[mapped]) {
    return mapped;
  }
  if ((state === "walking-left" || state === "walking-right") && metadata.animations.running) {
    return "running";
  }
  return metadata.animations.idle ? "idle" : Object.keys(metadata.animations)[0] ?? "idle";
}

function firstAnimation(metadata: DesktopPetMetadata): PetAnimation | null {
  return Object.values(metadata.animations)[0] ?? null;
}

function getFrame(animation: PetAnimation, elapsedSeconds: number): number {
  if (animation.frames <= 1) {
    return 0;
  }

  const rawFrame = Math.floor(elapsedSeconds * animation.fps);
  if (animation.loop === false) {
    return Math.min(animation.frames - 1, rawFrame);
  }
  return rawFrame % animation.frames;
}

function toFileUrl(input: string): string {
  if (input.startsWith("file://")) {
    return input;
  }
  const normalized = input.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    const [drive, ...rest] = normalized.split("/");
    return `file:///${drive}/${rest.map(encodeURIComponent).join("/")}`;
  }
  return normalized;
}
