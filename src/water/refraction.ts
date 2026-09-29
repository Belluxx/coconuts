import { FramebufferTexture, HalfFloatType, LinearFilter, type PixelFormatGPU, type RenderTarget } from 'three/webgpu';
import { viewportTexture } from 'three/tsl';
import type { TSLNode } from '../shading';

/** One opaque HDR capture per camera target and frame, shared by all water. */
export function createRefractionCapture() {
  const captures = new Map<RenderTarget | null, { texture: FramebufferTexture; frame: number }>();
  const get = (target: RenderTarget | null) => {
    let capture = captures.get(target);
    if (!capture) {
      const texture = new FramebufferTexture(1, 1);
      texture.name = 'Water · shared opaque refraction';
      texture.type = HalfFloatType; texture.internalFormat = 'rgba16float' as PixelFormatGPU;
      texture.minFilter = texture.magFilter = LinearFilter;
      capture = { texture, frame: -1 }; captures.set(target, capture);
    }
    return capture;
  };
  return {
    sample(uv: TSLNode) {
      const node = viewportTexture(uv, null, get(null).texture);
      node.getTextureForReference = (target = null) => get(target).texture;
      node.updateBeforeType = 'render';
      const update = node.updateBefore.bind(node);
      node.updateBefore = frame => {
        if (!frame.renderer) return;
        const capture = get(frame.renderer.getRenderTarget());
        if (capture.frame === frame.frameId) return;
        update(frame); capture.frame = frame.frameId;
      };
      return node;
    },
  };
}
export type RefractionCapture = ReturnType<typeof createRefractionCapture>;
