import { useEffect, useMemo, useRef } from "react";
import { type BehaviorState, type DesktopPetMetadata, type InstalledPetPack, type PetAnimation } from "../../shared/types";

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
  const metadataRef = useRef<DesktopPetMetadata | null>(pack.metadata);
  metadataRef.current = pack.metadata;

  const spriteUrl = useMemo(() => toFileUrl(pack.spritesheetPath), [pack.spritesheetPath]);

  useEffect(() => {
    const image = new Image();
    image.src = spriteUrl;
    imageRef.current = image;
    return () => {
      imageRef.current = null;
    };
  }, [spriteUrl]);

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

      const metadata = metadataRef.current ?? inferMetadata(image);
      const animationName = resolveAnimation(metadata, state);
      const animation = metadata.animations[animationName] ?? metadata.animations.idle ?? firstAnimation(metadata);
      const frameWidth = metadata.frameWidth;
      const frameHeight = metadata.frameHeight;
      const targetWidth = Math.round(frameWidth * scale);
      const targetHeight = Math.round(frameHeight * scale);

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        canvas.style.width = `${targetWidth}px`;
        canvas.style.height = `${targetHeight}px`;
      }

      const context = canvas.getContext("2d");
      if (!context || !animation) {
        frameId = requestAnimationFrame(draw);
        return;
      }

      const elapsed = Math.max(0, time - startedAt) / 1000;
      const frame = getFrame(animation, elapsed);
      const sourceX = ((animation.startFrame ?? 0) + frame) * frameWidth;
      const sourceY = animation.row * frameHeight;

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      context.drawImage(image, sourceX, sourceY, frameWidth, frameHeight, 0, 0, targetWidth, targetHeight);

      frameId = requestAnimationFrame(draw);
    };

    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [pack.metadata, scale, state]);

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

function inferMetadata(image: HTMLImageElement): DesktopPetMetadata {
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
