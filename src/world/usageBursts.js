import * as THREE from 'three'

/**
 * Spend orbs — a small glowing hop from the usage canister to whichever agent just spent
 * something, fired once per spend delta the poll saw. Parented straight to the scene, the
 * same as the switchboard's beams and for the same reason: both ends are arbitrary world
 * points, nowhere near each other's origin.
 */

const ORB_LIFETIME = 1.15
const MAX_ORBS = 12
const HOP_HEIGHT = 1.4

export class UsageBursts {
  constructor(scene) {
    this.scene = scene
    this.geometry = new THREE.SphereGeometry(0.12, 10, 8)
    this.orbs = []
    for (let i = 0; i < MAX_ORBS; i++) {
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, toneMapped: false })
      const mesh = new THREE.Mesh(this.geometry, material)
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 6
      scene.add(mesh)
      this.orbs.push({ mesh, life: 0, from: new THREE.Vector3(), to: new THREE.Vector3() })
    }
  }

  /** Fire one orb from `from` to `to` (both world space), tinted `color`. */
  fire(from, to, color) {
    let slot = this.orbs.find((o) => o.life <= 0)
    if (!slot) slot = this.orbs.reduce((a, b) => (a.life < b.life ? a : b))
    slot.from.copy(from)
    slot.to.copy(to)
    slot.mesh.material.color.set(color)
    slot.mesh.visible = true
    slot.life = ORB_LIFETIME
  }

  /** Cut every orb immediately — used when the feature is switched off mid-flight. */
  clear() {
    for (const o of this.orbs) {
      o.life = 0
      o.mesh.visible = false
      o.mesh.material.opacity = 0
    }
  }

  update(dt) {
    for (const o of this.orbs) {
      if (o.life <= 0) continue
      o.life -= dt
      if (o.life <= 0) {
        o.mesh.visible = false
        continue
      }
      const t = 1 - o.life / ORB_LIFETIME
      const arc = Math.sin(t * Math.PI) * HOP_HEIGHT
      o.mesh.position.lerpVectors(o.from, o.to, t)
      o.mesh.position.y += arc
      // Flares in, holds, then drops off fast at the very end rather than lingering as a dot.
      o.mesh.material.opacity = t < 0.15 ? t / 0.15 : Math.min(1, o.life / (ORB_LIFETIME * 0.25))
      const scale = 0.7 + Math.sin(t * Math.PI) * 0.5
      o.mesh.scale.setScalar(scale)
    }
  }

  dispose() {
    this.geometry.dispose()
    for (const { mesh } of this.orbs) {
      mesh.material.dispose()
      this.scene.remove(mesh)
    }
  }
}
