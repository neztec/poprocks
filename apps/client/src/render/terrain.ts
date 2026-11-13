import { CanvasSource, Container, Sprite, Texture } from 'pixi.js';
import { CHUNK, MAT, MATERIALS, type Asteroid } from '@poprock/shared';

interface Chunk {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  source: CanvasSource;
  sprite: Sprite;
}

/** Draws one asteroid as a grid of 1-pixel-per-cell chunk textures, scaled up with nearest filtering. */
export class TerrainView {
  readonly container = new Container();
  private chunks: Chunk[] = [];
  private chunkCols: number;

  constructor(private ast: Asteroid) {
    this.chunkCols = Math.ceil(ast.cols / CHUNK);
    const chunkRows = Math.ceil(ast.rows / CHUNK);
    for (let cr = 0; cr < chunkRows; cr++) {
      for (let cc = 0; cc < this.chunkCols; cc++) {
        const canvas = document.createElement('canvas');
        canvas.width = CHUNK;
        canvas.height = CHUNK;
        const ctx = canvas.getContext('2d')!;
        const source = new CanvasSource({ resource: canvas, scaleMode: 'nearest' });
        const sprite = new Sprite(new Texture({ source }));
        sprite.x = ast.x + cc * CHUNK * ast.cell;
        sprite.y = ast.y + cr * CHUNK * ast.cell;
        sprite.scale.set(ast.cell);
        this.container.addChild(sprite);
        const chunk = { canvas, ctx, image: ctx.createImageData(CHUNK, CHUNK), source, sprite };
        this.chunks.push(chunk);
        this.draw(cr * this.chunkCols + cc);
      }
    }
    ast.dirtyChunks.clear();
  }

  /** Redraw chunks touched since last frame. */
  update(): void {
    if (this.ast.dirtyChunks.size === 0) return;
    for (const i of this.ast.dirtyChunks) this.draw(i);
    this.ast.dirtyChunks.clear();
  }

  private draw(index: number): void {
    const chunk = this.chunks[index];
    if (!chunk) return;
    const { ast } = this;
    const cc = index % this.chunkCols;
    const cr = Math.floor(index / this.chunkCols);
    const data = chunk.image.data;
    const cells = ast.cells;
    for (let ly = 0; ly < CHUNK; ly++) {
      const row = cr * CHUNK + ly;
      for (let lx = 0; lx < CHUNK; lx++) {
        const col = cc * CHUNK + lx;
        const o = (ly * CHUNK + lx) * 4;
        if (row >= ast.rows || col >= ast.cols) {
          data[o + 3] = 0;
          continue;
        }
        const i = row * ast.cols + col;
        const m = cells[i];
        if (m === MAT.EMPTY) {
          data[o + 3] = 0;
          continue;
        }
        const [r, g, b] = MATERIALS[m].color;
        // Light the exposed faces so tunnels read clearly; small hash jitter for texture.
        const edge =
          (col > 0 && cells[i - 1] === 0) ||
          (col < ast.cols - 1 && cells[i + 1] === 0) ||
          (row > 0 && cells[i - ast.cols] === 0) ||
          (row < ast.rows - 1 && cells[i + ast.cols] === 0);
        const jitter = (((col * 73856093) ^ (row * 19349663)) & 15) - 8;
        const lift = edge ? 46 : 0;
        data[o] = clamp(r + jitter + lift);
        data[o + 1] = clamp(g + jitter + lift);
        data[o + 2] = clamp(b + jitter + lift);
        data[o + 3] = 255;
      }
    }
    chunk.ctx.putImageData(chunk.image, 0, 0);
    chunk.source.update();
  }

  destroy(): void {
    this.container.destroy({ children: true, texture: true, textureSource: true });
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
