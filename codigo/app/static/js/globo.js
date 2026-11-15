// Planeta en 3D que gira (Three.js, copia local en /static/vendor para que funcione sin internet).
// Uso: crearGlobo(contenedor, { textura, relieve, atmosfera, inclinacion, velocidad })
// Se puede arrastrar para girarlo. Se pausa solo cuando no está en pantalla.

import * as THREE from "/static/vendor/three.module.min.js";

const reducirMovimiento = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Brillo en el borde (atmósfera): más intenso donde la superficie se ve de canto.
function crearAtmosfera(color, intensidad, escala) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, intensidad: { value: intensidad }, luz: { value: new THREE.Vector3() } },
    vertexShader: `
      varying vec3 vNormal; varying vec3 vVista; varying vec3 vNormalMundo;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vNormalMundo = normalize(mat3(modelMatrix) * normal);
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        vVista = normalize(-p.xyz);
        gl_Position = projectionMatrix * p;
      }`,
    fragmentShader: `
      uniform vec3 color; uniform float intensidad; uniform vec3 luz;
      varying vec3 vNormal; varying vec3 vVista; varying vec3 vNormalMundo;
      void main() {
        float borde = pow(1.0 - abs(dot(vNormal, vVista)), 4.5);
        float dia = smoothstep(-0.35, 0.6, dot(vNormalMundo, normalize(luz)));
        gl_FragColor = vec4(color, borde * intensidad * dia);
      }`,
    side: THREE.FrontSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const malla = new THREE.Mesh(new THREE.SphereGeometry(escala, 96, 96), mat);
  return malla;
}

export function crearGlobo(contenedor, op = {}) {
  const {
    textura, relieve = null, relieveEscala = 0.02,
    atmosfera = null, atmosferaIntensidad = 1.2,
    inclinacion = 0, velocidad = 0.05, distancia = 3.5,
    luz = [-3.2, 1.2, 2.4], ambiente = 0.035,
  } = op;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    // Sin WebGL: imagen fija de respaldo
    contenedor.classList.add("sin-webgl");
    contenedor.style.setProperty("--tex", `url(${textura})`);
    return { destruir() {} };
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  contenedor.append(renderer.domElement);

  const escena = new THREE.Scene();
  const camara = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camara.position.set(0, 0, distancia);

  // Aparece suavemente cuando termina de cargar la textura
  const lienzo = renderer.domElement;
  lienzo.style.opacity = "0";
  lienzo.style.transition = "opacity 1.6s ease";
  const cargador = new THREE.TextureLoader();
  const mapa = cargador.load(textura, () => { lienzo.style.opacity = "1"; });
  mapa.colorSpace = THREE.SRGBColorSpace;
  mapa.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const material = new THREE.MeshStandardMaterial({ map: mapa, roughness: 1, metalness: 0 });
  if (relieve) {
    material.bumpMap = cargador.load(relieve);
    material.bumpScale = relieveEscala * 50;
  }

  // Eje inclinado: un grupo para la inclinación y la esfera gira dentro
  const eje = new THREE.Group();
  eje.rotation.z = THREE.MathUtils.degToRad(inclinacion);
  escena.add(eje);
  const esfera = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128), material);
  eje.add(esfera);

  const sol = new THREE.DirectionalLight(0xffffff, 3.2);
  sol.position.set(...luz);
  escena.add(sol);
  escena.add(new THREE.AmbientLight(0xffffff, ambiente));

  let atm = null;
  if (atmosfera) {
    atm = crearAtmosfera(atmosfera, atmosferaIntensidad, 1.025);
    atm.material.uniforms.luz.value.set(...luz);
    escena.add(atm);
  }

  // Arrastrar para girar (con inercia)
  let arrastrando = false, ultX = 0, ultY = 0, velX = 0;
  lienzo.style.touchAction = "pan-y";
  lienzo.addEventListener("pointerdown", (e) => { arrastrando = true; ultX = e.clientX; ultY = e.clientY; lienzo.setPointerCapture(e.pointerId); });
  lienzo.addEventListener("pointermove", (e) => {
    if (!arrastrando) return;
    const dx = e.clientX - ultX, dy = e.clientY - ultY;
    ultX = e.clientX; ultY = e.clientY;
    velX = dx * 0.005;
    esfera.rotation.y += velX;
    esfera.rotation.x = THREE.MathUtils.clamp(esfera.rotation.x + dy * 0.003, -0.6, 0.6);
  });
  const soltar = () => { arrastrando = false; };
  lienzo.addEventListener("pointerup", soltar);
  lienzo.addEventListener("pointercancel", soltar);

  function ajustar() {
    const { width, height } = contenedor.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camara.aspect = width / height;
    camara.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(ajustar);
  ro.observe(contenedor);

  let visible = false, cuadro = null, antes = performance.now();
  const giro = reducirMovimiento ? 0 : velocidad;
  function animar(t) {
    const dt = Math.min((t - antes) / 1000, 0.1);
    antes = t;
    if (!arrastrando) {
      velX *= 0.94;
      esfera.rotation.y += giro * dt + velX;
      esfera.rotation.x *= 0.985;
    }
    renderer.render(escena, camara);
    cuadro = visible ? requestAnimationFrame(animar) : null;
  }
  const io = new IntersectionObserver(([entrada]) => {
    visible = entrada.isIntersecting && !document.hidden;
    if (visible && !cuadro) { antes = performance.now(); cuadro = requestAnimationFrame(animar); }
  });
  io.observe(contenedor);
  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden && contenedor.offsetParent !== null;
    if (visible && !cuadro) { antes = performance.now(); cuadro = requestAnimationFrame(animar); }
  });

  return {
    destruir() { io.disconnect(); ro.disconnect(); cancelAnimationFrame(cuadro); renderer.dispose(); lienzo.remove(); },
  };
}
