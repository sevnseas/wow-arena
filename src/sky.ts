import * as THREE from 'three';

const SKY_SHADER = {
  vertexShader: `
    varying vec3 vWorldPosition;

    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;

      vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position = pos.xyww;
    }
  `,
  fragmentShader: `
    precision mediump float;

    varying vec3 vWorldPosition;

    uniform float uSunAzimuth;
    uniform float uSunElevation;
    uniform vec3 uSunColor;
    uniform vec3 uSkyColorLow;
    uniform vec3 uSkyColorHigh;
    uniform float uSunSize;

    void main() {
      vec3 direction = normalize(vWorldPosition);
      vec3 skyColor = mix(
        uSkyColorLow,
        uSkyColorHigh,
        clamp(direction.y * 0.5 + 0.5, 0.0, 1.0)
      );

      float azimuth = radians(uSunAzimuth);
      float elevation = radians(uSunElevation);
      vec3 sunDirection = normalize(vec3(
        cos(elevation) * sin(azimuth),
        sin(elevation),
        cos(elevation) * cos(azimuth)
      ));

      float sunIntensity = pow(max(dot(direction, sunDirection), 0.0), 1000.0 / uSunSize);
      vec3 sunColor = uSunColor * sunIntensity;

      gl_FragColor = vec4(skyColor + sunColor, 1.0);
    }
  `
};

const CLOUDS_SHADER = {
  vertexShader: `
    varying vec2 vUv;

    void main() {
      vUv = uv;

      vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position = pos.xyww;
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform vec3 uCloudColor;
    uniform vec3 cameraPos;

    varying vec2 vUv;

    vec3 permute(vec3 x) {
      return mod(((x * 34.0) + 1.0) * x, 289.0);
    }

    float snoise(vec2 v) {
      const vec4 C = vec4(
        0.211324865405187,
        0.366025403784439,
        -0.577350269189626,
        0.024390243902439
      );
      vec2 i = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod(i, 289.0);
      vec3 p = permute(
        permute(i.y + vec3(0.0, i1.y, 1.0)) +
        i.x + vec3(0.0, i1.x, 1.0)
      );
      vec3 m = max(
        0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)),
        0.0
      );
      m = m * m;
      m = m * m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
      vec3 g;
      g.x = a0.x * x0.x + h.x * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }

    void main() {
      vec2 cloudUV = vUv * 6.0 + vec2(
        cameraPos.x / 1000.0 + uTime / 100.0,
        cameraPos.z / 1000.0
      );

      float n = snoise(cloudUV * 3.0 + uTime / 50.0) * 0.6
              + snoise(cloudUV * 6.0 + uTime / 40.0) * 0.3
              + snoise(cloudUV * 12.0 + uTime / 30.0) * 0.1;

      float cloudDensity = smoothstep(0.1, 0.9, 0.5 * n + 0.5);
      float horizonFade = smoothstep(0.0, 0.3, 1.0 - abs(vUv.y - 0.5) * 2.0);
      float edgeFade = (1.0 - pow(abs(vUv.x - 0.5) * 2.0, 2.0)) *
        (1.0 - pow(abs(vUv.y - 0.5) * 2.0, 2.0));

      float finalOpacity = cloudDensity * horizonFade * edgeFade * 0.45;

      gl_FragColor = vec4(uCloudColor, finalOpacity);
      if (finalOpacity < 0.01) discard;
    }
  `
};

const STARS_SHADER = {
  vertexShader: `
    attribute float size;
    attribute vec3 color;
    attribute float phase;
    attribute float freq;

    varying vec3 vColor;
    varying float vDepth;

    uniform float time;

    void main() {
      vColor = color;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vDepth = mvPosition.z;

      float twinkle = sin(time * freq + phase) * 0.2 + 0.8;
      gl_PointSize = size * twinkle;

      vec4 pos = projectionMatrix * mvPosition;
      pos.z = pos.w * 0.999999;
      gl_Position = pos;
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    varying float vDepth;

    void main() {
      vec2 center = gl_PointCoord - vec2(0.5);
      float dist = length(center) * 2.0;

      float core = (1.0 - smoothstep(0.0, 0.2, dist)) * 0.8;
      float glow = (1.0 - smoothstep(0.2, 0.5, dist)) * 0.1;
      float brightness = core + glow;
      float reflectionFactor = smoothstep(0.0, -1000.0, vDepth) * 0.5;

      vec3 finalColor = mix(vec3(1.0), vColor, 0.8) * 0.6;
      gl_FragColor = vec4(finalColor, brightness * reflectionFactor);
    }
  `
};

function generateHemispherePositions(count: number): Float32Array {
  const positions = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const u = Math.random();
    const v = Math.random() * 0.5 + 0.5;
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);

    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.cos(phi);
    const z = Math.sin(phi) * Math.sin(theta);
    positions.set([x, y, z], i * 3);
  }

  return positions;
}

function mirrorPositions(topPositions: Float32Array): Float32Array {
  const count = topPositions.length / 3;
  const mirrored = new Float32Array(topPositions.length * 2);
  mirrored.set(topPositions, 0);

  for (let i = 0; i < count; i++) {
    const x = topPositions[i * 3 + 0];
    const y = topPositions[i * 3 + 1];
    const z = topPositions[i * 3 + 2];
    mirrored.set([x, -y, z], (i + count) * 3);
  }

  return mirrored;
}

function mirrorAttribute(attr: Float32Array): Float32Array {
  const mirrored = new Float32Array(attr.length * 2);
  mirrored.set(attr, 0);
  mirrored.set(attr, attr.length);
  return mirrored;
}

function generateStarColors(count: number): Float32Array {
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const variation = Math.random();
    const color =
      variation < 0.15
        ? [0.8, 0.85, 1.0]
        : variation < 0.3
        ? [1.0, 0.95, 0.8]
        : [1.0, 1.0, 1.0];
    colors.set(color, i * 3);
  }

  return colors;
}

function generateStarSizes(count: number): Float32Array {
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const variation = Math.random();
    sizes[i] =
      variation < 0.01
        ? 40 + Math.random() * 20
        : variation < 0.05
        ? 25 + Math.random() * 15
        : variation < 0.2
        ? 15 + Math.random() * 10
        : 5 + Math.random() * 5;
  }

  return sizes;
}

function generateRandomScalars(count: number, min: number, max: number): Float32Array {
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    values[i] = min + Math.random() * (max - min);
  }
  return values;
}

function buildStars(count = 5000): THREE.Points {
  const halfCount = Math.floor(count / 2);
  const geometry = new THREE.BufferGeometry();

  const topPositions = generateHemispherePositions(halfCount);
  const positions = mirrorPositions(topPositions);
  const colors = mirrorAttribute(generateStarColors(halfCount));
  const sizes = mirrorAttribute(generateStarSizes(halfCount));
  const phases = mirrorAttribute(generateRandomScalars(halfCount, 0, Math.PI * 2));
  const freqs = mirrorAttribute(generateRandomScalars(halfCount, 1.0, 3.0));

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('freq', new THREE.BufferAttribute(freqs, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    vertexShader: STARS_SHADER.vertexShader,
    fragmentShader: STARS_SHADER.fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  });

  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  stars.scale.setScalar(950);

  return stars;
}

export class SkyEnvironment extends THREE.Group {
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly cloudMaterial: THREE.ShaderMaterial;
  private readonly starsMaterial: THREE.ShaderMaterial;
  private readonly sky: THREE.Mesh;
  private readonly clouds: THREE.Mesh;
  private readonly stars: THREE.Points;
  private readonly ambient: THREE.AmbientLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly fogColor = new THREE.Color();
  private readonly sunDirection = new THREE.Vector3();
  private readonly lowerSkyColor = new THREE.Color();
  private readonly upperSkyColor = new THREE.Color();
  private readonly sunColor = new THREE.Color();
  private elapsedTime = 0;
  private gameMinutes = 9 * 60;

  constructor() {
    super();
    this.name = 'SkyEnvironment';

    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_SHADER.vertexShader,
      fragmentShader: SKY_SHADER.fragmentShader,
      uniforms: {
        uSunAzimuth: { value: 216 },
        uSunElevation: { value: 25 },
        uSunColor: { value: new THREE.Color(0xffe5b0) },
        uSkyColorLow: { value: new THREE.Color(0x6fa2ef) },
        uSkyColorHigh: { value: new THREE.Color(0x2053ff) },
        uSunSize: { value: 1.0 }
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.skyMaterial);
    this.sky.frustumCulled = false;
    this.sky.scale.setScalar(900);

    this.cloudMaterial = new THREE.ShaderMaterial({
      vertexShader: CLOUDS_SHADER.vertexShader,
      fragmentShader: CLOUDS_SHADER.fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uCloudColor: { value: new THREE.Color(1, 1, 1) },
        cameraPos: { value: new THREE.Vector3() }
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      fog: false
    });

    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.cloudMaterial);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -1;
    this.clouds.rotation.x = Math.PI / 2;
    this.clouds.position.y = 350;
    this.clouds.scale.setScalar(1400);

    this.stars = buildStars();
    this.starsMaterial = this.stars.material as THREE.ShaderMaterial;

    this.ambient = new THREE.AmbientLight(0xffffff, 0.35);
    this.hemi = new THREE.HemisphereLight(0x87ceeb, 0x243018, 0.25);
    this.sun = new THREE.DirectionalLight(0xffffee, 1.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 300;
    this.sun.shadow.camera.left = -35;
    this.sun.shadow.camera.right = 35;
    this.sun.shadow.camera.top = 35;
    this.sun.shadow.camera.bottom = -35;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.bias = -0.0001;

    this.add(this.sky);
    this.add(this.clouds);
    this.add(this.stars);
    this.add(this.ambient);
    this.add(this.hemi);
    this.add(this.sun);
    this.add(this.sun.target);
  }

  update(
    delta: number,
    focusPosition: THREE.Vector3,
    camera: THREE.Camera,
    scene: THREE.Scene
  ): void {
    this.elapsedTime += delta;
    this.gameMinutes = (this.gameMinutes + delta * 6) % (24 * 60);

    const timeInHours = this.gameMinutes / 60;
    const sunrise = 6;
    const sunset = 21;
    const darknessStart = 20.42;
    const darknessEnd = 6.58;
    const maxElevation = 42;

    const white = new THREE.Color(0xffffff);
    const orange = new THREE.Color(0xff4500);
    const yellow = new THREE.Color(0xffd700);
    const red = new THREE.Color(0xff6347);
    const darkRed = new THREE.Color(0xd32f2f);
    const skyBlue = new THREE.Color(0x87ceeb);
    const darkSky = new THREE.Color(0x0d1321);
    const nightSky = new THREE.Color(0x1c2331);
    const moon = new THREE.Color(0xe6e8fa);

    const isInDarkTransition =
      (timeInHours >= darknessStart && timeInHours <= sunset) ||
      (timeInHours >= sunrise && timeInHours <= darknessEnd);
    const isDaytime = timeInHours >= sunrise && timeInHours <= sunset;

    let normalizedTime: number;
    if (isDaytime) {
      normalizedTime = (timeInHours - sunrise) / (sunset - sunrise);
    } else {
      const nightHour = timeInHours >= sunset ? timeInHours : timeInHours + 24;
      normalizedTime = (nightHour - sunset) / (24 - sunset + sunrise);
    }

    let sunElevation = Math.cos(Math.PI * (normalizedTime - 0.5)) * maxElevation - 5;
    const sunAzimuth = 180 + 180 * normalizedTime;
    let timeOfDay: 'Nighttime' | 'Sunrise' | 'Midday' | 'Sunset' = 'Nighttime';

    if (isDaytime) {
      if (normalizedTime <= 0.25) timeOfDay = 'Sunrise';
      else if (normalizedTime <= 0.75) timeOfDay = 'Midday';
      else timeOfDay = 'Sunset';
    }

    if (isDaytime) {
      const normalizedElevation = Math.min(Math.max(sunElevation / maxElevation, 0), 1);
      const t = Math.pow(1 - normalizedElevation, 3);

      this.sunColor.lerpColors(white, orange, t);

      let horizonColor = skyBlue.clone();
      if (timeOfDay === 'Sunrise') {
        horizonColor = yellow.clone().lerp(red, normalizedTime / 0.25);
      } else if (timeOfDay === 'Sunset') {
        horizonColor = red.clone().lerp(darkRed, (normalizedTime - 0.75) / 0.25);
      }

      this.lowerSkyColor.copy(horizonColor);
      this.upperSkyColor.lerpColors(skyBlue, darkSky, t);

      this.sun.intensity = isInDarkTransition
        ? 0.25
        : Math.min(3.5, Math.pow(normalizedElevation, 1.2) * 3.5);
      this.ambient.intensity = 0.2 + normalizedElevation * 0.3;
      this.hemi.intensity = 0.15 + normalizedElevation * 0.35;
      this.clouds.visible = true;
      this.stars.visible = false;
      this.cloudMaterial.uniforms.uCloudColor.value.copy(
        timeOfDay === 'Sunrise'
          ? new THREE.Color(0.85, 0.5, 0.45)
          : timeOfDay === 'Sunset'
          ? new THREE.Color(0.85, 0.38, 0.35)
          : new THREE.Color(1.0, 1.0, 1.0)
      );
    } else {
      sunElevation *= 0.5;
      this.sunColor.copy(moon).multiplyScalar(1.8);
      this.lowerSkyColor.copy(darkSky);
      this.upperSkyColor.copy(nightSky);
      this.sun.intensity = 0.35;
      this.ambient.intensity = 0.12;
      this.hemi.intensity = 0.1;
      this.clouds.visible = false;
      this.stars.visible = true;
    }

    this.skyMaterial.uniforms.uSunColor.value.copy(this.sunColor);
    this.skyMaterial.uniforms.uSkyColorLow.value.copy(this.lowerSkyColor);
    this.skyMaterial.uniforms.uSkyColorHigh.value.copy(this.upperSkyColor);
    this.skyMaterial.uniforms.uSunAzimuth.value = ((270 - sunAzimuth) % 360) - 180;
    this.skyMaterial.uniforms.uSunElevation.value = sunElevation;

    const elevationRad = THREE.MathUtils.degToRad(sunElevation);
    const azimuthRad = THREE.MathUtils.degToRad(((270 - sunAzimuth) % 360) - 180);
    this.sunDirection.set(
      Math.cos(elevationRad) * Math.sin(azimuthRad),
      Math.sin(elevationRad),
      Math.cos(elevationRad) * Math.cos(azimuthRad)
    ).normalize();

    this.sky.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.clouds.position.set(camera.position.x, 350, camera.position.z);

    this.sun.position.copy(focusPosition).addScaledVector(this.sunDirection, 120);
    this.sun.target.position.copy(focusPosition);
    this.sun.target.updateMatrixWorld();
    this.sun.color.copy(this.sunColor);

    this.hemi.color.copy(this.upperSkyColor);
    this.hemi.groundColor.set(isDaytime ? 0x3d5c3d : 0x10140f);

    this.cloudMaterial.uniforms.uTime.value += delta;
    this.cloudMaterial.uniforms.cameraPos.value.copy(camera.position);
    this.starsMaterial.uniforms.time.value = this.elapsedTime;

    this.fogColor.copy(this.lowerSkyColor).lerp(this.upperSkyColor, 0.35);
    scene.background = this.upperSkyColor.clone();
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.copy(this.fogColor);
    }
  }
}
