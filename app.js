import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Static, same-origin application. All geometry, navigation and provenance come
// from the Blender export; no remote CDN, analytics or application server.
const $ = id => document.getElementById(id);
const mobile = matchMedia('(pointer: coarse)').matches || innerWidth < 769;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const v3 = a => new THREE.Vector3().fromArray(a);
const clamp = THREE.MathUtils.clamp;
const qualityProfiles = {
  low: { ratio: 1, shadows: false },
  medium: { ratio: 1.5, shadows: false },
  high: { ratio: 2, shadows: true },
};
let quality = mobile ? 'low' : 'medium';
try { quality = localStorage.getItem('school-quality') || quality; } catch {}
if (!qualityProfiles[quality]) quality = mobile ? 'low' : 'medium';
$('qualitySelect').value = quality;

let renderer, camera, scene, controls, sunlight;
let manifest, prototypeScene, prototypePromise;
let booted = false, destroyed = false, activeFloor = 1, visibilityMode = 'all';
let mode = 'orbit', currentRoom = null, floorSelectionToken = 0;
let motion = null, tourToken = 0, touring = false, retryOperation = null;
let yaw = 0, pitch = 0, footY = .45;
let lastTime = performance.now(), lastMeasure = lastTime, measuredFrames = 0;
let totalFpsSamples = 0, pointerLookFallback = false;
const fpsHistory = [];
let totalCompleted = 0, backgroundBoot = true;
const floors = new Map(), environments = new Map(), hiddenFloors = new Set();
const prototypeMeshes = new Map(), pending = new Map(), keys = new Set();
const markerItems = [], externalColliders = [];
const joystick = { x: 0, y: 0, pointer: null };
const lookTouch = { id: null, x: 0, y: 0 };
const tempMatrix = new THREE.Matrix4(), instanceMatrix = new THREE.Matrix4();
const direction = new THREE.Vector3(), projected = new THREE.Vector3();
let toastTimer;

function fitMobileOverview(position,target,fov,bounds={min:[-32,-.4,-8],max:[32,20.5,8]}) {
  if(!mobile)return [...position];
  const center=v3(target),back=v3(position).sub(center),minimum=back.length();
  back.normalize();
  const forward=back.clone().negate();
  const right=new THREE.Vector3().crossVectors(forward,new THREE.Vector3(0,1,0)).normalize();
  const up=new THREE.Vector3().crossVectors(right,forward).normalize();
  const aspect=($('viewport').clientWidth||innerWidth)/($('viewport').clientHeight||innerHeight);
  const tanV=Math.tan(THREE.MathUtils.degToRad(fov)/2),tanH=tanV*aspect;
  let distance=minimum;
  // Fit all eight real building corners into 94% of the horizontal viewport.
  // This keeps the original viewing direction and desktop composition intact.
  for(const x of [bounds.min[0],bounds.max[0]])for(const y of [bounds.min[1],bounds.max[1]])for(const z of [bounds.min[2],bounds.max[2]]){
    const corner=new THREE.Vector3(x,y,z).sub(center),depth=corner.dot(back);
    distance=Math.max(distance,Math.abs(corner.dot(right))/(tanH*.94)+depth,
      Math.abs(corner.dot(up))/(tanV*.82)+depth);
  }
  return center.addScaledVector(back,distance).toArray();
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3600);
}

function showError(error, retry, fatal = false) {
  console.error(error);
  const prefix = location.protocol === 'file:'
    ? '请通过本地 HTTP 服务或 GitHub Pages 打开此页面。浏览器无法从 file:// 加载模型。 '
    : '';
  $('errorText').textContent = prefix + (error?.message || String(error));
  $('errorPanel').hidden = false;
  retryOperation = retry || (() => location.reload());
  if (fatal) $('loading').hidden = true;
  $('sceneStatus').textContent = '加载中断';
}

function progressStart(key, label) {
  pending.set(key, { label, loaded: 0, total: 0 });
  updateProgress();
}
function progressEnd(key) {
  pending.delete(key); totalCompleted++; updateProgress();
}
function updateProgress() {
  const jobs = [...pending.values()];
  const label = jobs[0]?.label || '场景已就绪';
  $('loadingText').textContent = jobs.length ? `${label} · 已完成 ${totalCompleted} 项` : label;
  $('backgroundLoadingText').textContent = jobs.length > 1 ? `${label} · ${jobs.length} 项` : label;
  $('backgroundLoading').hidden = !booted || jobs.length === 0;
  const sized = jobs.filter(j => j.total > 0);
  const track = $('loadingProgress').parentElement;
  track.classList.toggle('indeterminate', jobs.length > 0 && sized.length === 0);
  if (sized.length) {
    const bytes = sized.reduce((a,j) => a+j.loaded,0);
    const total = sized.reduce((a,j) => a+j.total,0);
    $('loadingProgress').style.width = `${Math.round(bytes/total*100)}%`;
  } else if (!jobs.length) $('loadingProgress').style.width = '100%';
}

const urlFor = path => new URL(path, document.baseURI).href;
async function json(path, label) {
  const key = `json:${path}`;
  progressStart(key,label);
  try {
    const response = await fetch(urlFor(path));
    if (!response.ok) throw new Error(`${label}加载失败（HTTP ${response.status}）：${path}`);
    return await response.json();
  } finally { progressEnd(key); }
}

const loader = new GLTFLoader();
async function glb(path,label) {
  const key=`glb:${path}`; progressStart(key,label);
  try {
    const gltf=await loader.loadAsync(urlFor(path), event => {
      const job=pending.get(key);
      if (job) { job.loaded=event.loaded; job.total=event.total; updateProgress(); }
    });
    gltf.scene.updateMatrixWorld(true);
    prepareMeshes(gltf.scene);
    return gltf.scene;
  } catch (e) { throw new Error(`${label}加载失败：${path}。${e.message || ''}`); }
  finally { progressEnd(key); }
}

function prepareMaterial(material) {
  if (!material) return;
  if (!material.userData.schoolOriginal) {
    material.userData.schoolOriginal = {
      transmission: material.transmission || 0, opacity: material.opacity,
      transparent: material.transparent, depthWrite: material.depthWrite,
    };
  }
  const original=material.userData.schoolOriginal;
  if (original.transmission > .1) {
    // Low/medium use a transparent architectural pane rather than an expensive
    // per-pixel transmission pass. The original PBR material is retained.
    material.transmission=quality==='high' ? original.transmission : 0;
    material.opacity=quality==='high' ? original.opacity : .20;
    material.transparent=quality==='high' ? original.transparent : true;
    material.depthWrite=quality==='high' ? original.depthWrite : false;
  }
  for (const key of ['map','normalMap','roughnessMap','metalnessMap']) {
    if (material[key]) material[key].anisotropy=quality==='high' ? 4 : 1;
  }
  material.needsUpdate=true;
}
function prepareMeshes(root) {
  root.traverse(obj => {
    if (!obj.isMesh) return;
    const materials=Array.isArray(obj.material) ? obj.material : [obj.material];
    materials.forEach(prepareMaterial);
    obj.castShadow=quality==='high' && !materials.some(m => m.userData.schoolOriginal?.transmission > .1);
    obj.receiveShadow=quality==='high';
    obj.frustumCulled=true;
  });
}

function makeRenderer() {
  scene=new THREE.Scene(); scene.background=new THREE.Color('#e7e7e7');
  scene.fog=new THREE.Fog('#e7e7e7',145,430);
  camera=new THREE.PerspectiveCamera(mobile ? 52 : 44,innerWidth/innerHeight,.075,600);
  camera.position.fromArray(fitMobileOverview([-66,35,-67],[0,8,0],mobile?52:44));
  renderer=new THREE.WebGLRenderer({antialias:!mobile,powerPreference:'high-performance',alpha:false});
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.15;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  $('viewport').appendChild(renderer.domElement);
  renderer.domElement.setAttribute('tabindex','0');
  renderer.domElement.setAttribute('aria-label','教学楼三维视图；环绕模式可拖动浏览');
  controls=new OrbitControls(camera,renderer.domElement);
  controls.target.set(0,mobile?8:7,0); controls.enableDamping=true; controls.dampingFactor=.075;
  controls.minDistance=.6; controls.maxDistance=190; controls.maxPolarAngle=Math.PI*.49;
  controls.screenSpacePanning=true;
  controls.addEventListener('start',() => { stopTour(); cancelMotion(); });
  scene.add(new THREE.HemisphereLight(0xf8fcff,0xa6a598,2.05));
  const ambient=new THREE.AmbientLight(0xffffff,.38); scene.add(ambient);
  sunlight=new THREE.DirectionalLight(0xfff1d9,3.05);
  sunlight.position.set(-42,64,-34); sunlight.target.position.set(0,5,0);
  sunlight.shadow.mapSize.set(2048,2048);
  Object.assign(sunlight.shadow.camera,{left:-48,right:48,top:40,bottom:-40,near:1,far:180});
  sunlight.shadow.bias=-.00018; sunlight.shadow.normalBias=.035;
  scene.add(sunlight,sunlight.target);
  applyQuality(quality,false);
  const observer=new ResizeObserver(resize); observer.observe($('viewport'));
  renderer.domElement.addEventListener('webglcontextlost',event => {
    event.preventDefault(); showError(new Error('浏览器释放了图形上下文。请关闭其他占用显存的页面后重试。'),()=>location.reload());
  });
  renderer.domElement.addEventListener('webglcontextrestored',()=>location.reload());
  renderer.setAnimationLoop(frame);
}

function resize() {
  if (!renderer) return;
  const w=$('viewport').clientWidth,h=$('viewport').clientHeight;
  camera.aspect=w/h; camera.updateProjectionMatrix(); renderer.setSize(w,h,false);
}
function applyQuality(value,remember=true) {
  quality=value; const profile=qualityProfiles[value];
  if (renderer) {
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1,profile.ratio));
    renderer.shadowMap.enabled=profile.shadows;
    sunlight.castShadow=profile.shadows;
    scene.traverse(o => { if(o.isMesh) prepareMeshes(o); });
    if (prototypeScene) prepareMeshes(prototypeScene);
    resize();
  }
  $('qualitySelect').value=value;
  if (remember) { try { localStorage.setItem('school-quality',value); } catch {} }
}

async function ensurePrototypes() {
  if (prototypeScene) return prototypeScene;
  if (prototypePromise) return prototypePromise;
  prototypePromise=(async()=> {
    prototypeScene=await glb(typeof manifest.prototypes==='string' ? manifest.prototypes : manifest.prototypes.url,'可复用家具与门窗');
    prototypeScene.updateMatrixWorld(true);
    prototypeScene.children.forEach(source => {
      const meshes=[];
      source.traverse(child => {
        if (child.isMesh) meshes.push({geometry:child.geometry,material:child.material,
                                      decodeMatrix:child.matrixWorld.clone()});
      });
      prototypeMeshes.set(source.name,meshes);
    });
    return prototypeScene;
  })().catch(e=> { prototypePromise=null; throw e; });
  return prototypePromise;
}

const isArchitecture = prototype => /window|door|entryleaf/i.test(prototype);
function buildBatches(record,architecture) {
  const group=new THREE.Group(); group.name=`Floor_${record.id}_${architecture?'Openings':'Furniture'}`;
  const buckets=new Map();
  for (const item of record.instanceData.instances || []) {
    if (isArchitecture(item.prototype)!==architecture) continue;
    if (!buckets.has(item.prototype)) buckets.set(item.prototype,[]);
    buckets.get(item.prototype).push(item);
  }
  for (const [name,items] of buckets) {
    let sources=prototypeMeshes.get(name);
    if (!sources) {
      const mapped=manifest.prototypeNames?.[name];
      if (mapped) sources=prototypeMeshes.get(mapped);
    }
    if (!sources) throw new Error(`缺少可复用资产：${name}`);
    for (let part=0;part<sources.length;part++) {
      const source=sources[part];
      const batch=new THREE.InstancedMesh(source.geometry,source.material,items.length);
      batch.name=`F${record.id}_${name}_${part}`;
      batch.userData.prototype=name; batch.userData.floor=record.id;
      for (let i=0;i<items.length;i++) {
        instanceMatrix.fromArray(items[i].matrix);
        // KHR_mesh_quantization adds scale/translation on the child mesh. Its
        // decode transform MUST follow the exported world instance matrix.
        tempMatrix.multiplyMatrices(instanceMatrix,source.decodeMatrix);
        batch.setMatrixAt(i,tempMatrix);
      }
      batch.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      batch.instanceMatrix.needsUpdate=true;
      batch.computeBoundingBox(); batch.computeBoundingSphere();
      prepareMeshes(batch); group.add(batch);
    }
  }
  return group;
}

async function ensureFloorStructure(id) {
  const record=floors.get(Number(id));
  if (!record) throw new Error(`未找到楼层 ${id}`);
  if (record.structurePromise) return record.structurePromise;
  record.structurePromise=(async()=> {
    const object=await glb(record.url,`${record.name}建筑结构`);
    record.structure=object; record.group.add(object);
    syncVisibility(); return object;
  })().catch(e=> { record.structurePromise=null; throw e; });
  return record.structurePromise;
}

async function ensureFloorShell(id) {
  const record=floors.get(Number(id));
  if(!record.shell) return ensureFloorStructure(id);
  if(record.shellPromise) return record.shellPromise;
  record.shellPromise=(async()=> {
    record.shellObject=await glb(record.shell,`${record.name}外观轮廓`);
    record.group.add(record.shellObject);syncVisibility();
  })().catch(error=>{record.shellPromise=null;throw error;});
  return record.shellPromise;
}

async function ensureFloorData(id) {
  const record=floors.get(Number(id));
  if (record.dataPromise) return record.dataPromise;
  record.dataPromise=(async()=> {
    const [data,colliders]=await Promise.all([
      json(record.instances,`${record.name}资产索引`),
      record.colliders ? json(record.colliders,`${record.name}墙体碰撞`) : Promise.resolve({colliders:[]}),
    ]);
    record.instanceData=data; record.wallColliders=colliders.colliders || [];
    return record;
  })().catch(e=> { record.dataPromise=null; throw e; });
  return record.dataPromise;
}

async function ensureOpenings(id) {
  const record=floors.get(Number(id));
  if (record.openingsPromise) return record.openingsPromise;
  record.openingsPromise=(async()=> {
    await Promise.all([ensurePrototypes(),ensureFloorData(id)]);
    record.openings=buildBatches(record,true); record.group.add(record.openings);
    syncVisibility();
  })().catch(e=> { record.openingsPromise=null; throw e; });
  return record.openingsPromise;
}

async function ensureFurniture(id) {
  const record=floors.get(Number(id)); record.lastUsed=performance.now();
  if (record.furniture) return record.furniture;
  if (record.furniturePromise) return record.furniturePromise;
  record.furniturePromise=(async()=> {
    await Promise.all([ensureOpenings(id),ensureFloorStructure(id)]);
    record.furniture=buildBatches(record,false); record.group.add(record.furniture);
    record.lastUsed=performance.now(); syncVisibility();
    trimFurnitureCache();
    return record.furniture;
  })().catch(e=> { record.furniturePromise=null; throw e; });
  return record.furniturePromise;
}

function releaseFurniture(record) {
  if (!record.furniture) return;
  record.group.remove(record.furniture);
  record.furniture.traverse(obj=> { if(obj.isInstancedMesh) obj.dispose(); });
  // Geometries/materials remain owned by the shared prototype cache. Disposing
  // them here would invalidate every other floor using that same asset.
  record.furniture=null; record.furniturePromise=null;
  if(record.structure && record.shellObject && !destroyed) {
    record.group.remove(record.structure);
    const geometry=new Set(),material=new Set(),texture=new Set();
    record.structure.traverse(object=> {
      if(object.geometry)geometry.add(object.geometry);
      for(const m of Array.isArray(object.material)?object.material:[object.material]) {
        if(!m)continue;material.add(m);
        Object.values(m).forEach(value=>{if(value?.isTexture)texture.add(value);});
      }
    });
    texture.forEach(t=>t.dispose());material.forEach(m=>m.dispose());geometry.forEach(g=>g.dispose());
    record.structure=null;record.structurePromise=null;
    record.shellObject.visible=true;
  }
}
function trimFurnitureCache() {
  const maxCached=mobile?1:2;
  const cached=[...floors.values()].filter(f=>f.furniture).sort((a,b)=>b.lastUsed-a.lastUsed);
  let count=cached.length;
  for(const record of cached.reverse()) {
    if(count<=maxCached) break;
    if(record.id!==activeFloor) { releaseFurniture(record); count--; }
  }
}

async function loadEnvironment(spec) {
  const object=await glb(spec.url,({site:'校园地面',exterior:'外立面',roof:'屋顶'})[spec.id] || spec.id);
  object.name=`Environment_${spec.id}`; scene.add(object); environments.set(spec.id,object);
  if (spec.colliders) {
    json(spec.colliders,'室外碰撞信息').then(data=>externalColliders.push(...(data.colliders||[])))
      .catch(e=>console.warn('Outdoor colliders unavailable:',e));
  }
  syncVisibility();
}

function syncVisibility() {
  if(!camera) return;
  for(const record of floors.values()) {
    record.group.visible=!hiddenFloors.has(record.id) && (visibilityMode==='all' || record.id===activeFloor);
    if(record.structure)record.structure.visible=record.id===activeFloor||!record.shellObject;
    if(record.shellObject)record.shellObject.visible=!(record.structure&&record.id===activeFloor);
    if(record.furniture) record.furniture.visible=record.id===activeFloor;
  }
  if(environments.has('roof')) environments.get('roof').visible=$('roofToggle').checked && visibilityMode==='all';
  if(environments.has('exterior')) environments.get('exterior').visible=visibilityMode==='all';
  $('showAll').classList.toggle('selected',visibilityMode==='all');
  $('showAll').setAttribute('aria-pressed',String(visibilityMode==='all'));
  $('hideFloor').textContent=hiddenFloors.has(activeFloor)?'显示当前层':'隐藏当前层';
  for(const button of $('floorButtons').children) {
    const id=Number(button.dataset.floor);
    button.classList.toggle('active',id===activeFloor);
    button.classList.toggle('is-hidden',hiddenFloors.has(id));
    button.setAttribute('aria-pressed',String(id===activeFloor));
  }
  $('app').dataset.floor=String(activeFloor); $('app').dataset.visibility=visibilityMode;
}

function normalizeRooms() {
  const converted=manifest.coordinates?.up==='Y';
  return (manifest.rooms || []).map((raw,index)=> {
    const floor=Number(raw.floor || raw.floorId || 1);
    const fallbackFloor=floors.get(floor)?.elevation ?? .45+(floor-1)*3.6;
    const origin=raw.origin || [-25.67+(raw.bay || 0)*8.6,fallbackFloor,6.76];
    const o=converted ? [...origin] : [origin[0],origin[2],-origin[1]];
    const width=raw.width || 8.34,depth=raw.depth || 10.3;
    let title=raw.displayName || raw.label;
    if (!title) title=raw.type==='classroom' ? `${floor}${String((raw.bay ?? index)+1).padStart(2,'0')} 教室`
      : raw.type==='office' ? '教师办公室' : raw.gender==='female' ? '女卫生间' : '男卫生间';
    const door=raw.doors?.[raw.type==='classroom'?Math.min(1,raw.doors.length-1):0]?.position;
    return {...raw,id:raw.id || raw.name || `room-${floor}-${index}`,floor,title,
            origin:o,width,depth,
            marker:door ? [door[0],fallbackFloor+2.42,door[2]-.28]
                        : [o[0]+width*.5,fallbackFloor+2.42,-3.95]};
  });
}

function buildNavigation() {
  $('floorButtons').replaceChildren();
  for(const record of floors.values()) {
    const button=document.createElement('button'); button.className='floor-button';
    button.textContent=String(record.id)+'F'; button.dataset.floor=record.id;
    button.setAttribute('aria-label',`查看${record.name}`);
    button.addEventListener('click',()=>selectFloor(record.id,{isolate:true,move:true}));
    $('floorButtons').appendChild(button);
  }
  manifest.roomData=normalizeRooms();
  for(const room of manifest.roomData) {
    const marker=document.createElement('button'); marker.className='room-marker';
    marker.textContent=room.title; marker.tabIndex=-1;
    marker.addEventListener('click',()=>navigateRoom(room));
    $('markers').appendChild(marker); markerItems.push({room,element:marker,position:v3(room.marker)});
  }
  renderRoomList(); syncVisibility();
}

function renderRoomList() {
  const record=floors.get(activeFloor);
  $('roomsHeading').textContent=`${record?.name || activeFloor+'层'}空间`;
  const rooms=manifest.roomData.filter(r=>r.floor===activeFloor);
  $('roomCount').textContent=`${rooms.length} 个空间`;
  $('roomList').replaceChildren();
  for(const room of rooms) {
    const button=document.createElement('button'); button.className='room-button';
    button.classList.toggle('active',currentRoom?.id===room.id); button.dataset.room=room.id;
    const icon=document.createElement('span'); icon.className='room-icon';
    icon.textContent=room.type==='classroom'?'课':room.type==='office'?'办':room.gender==='female'?'女':'男';
    const label=document.createElement('span'),title=document.createElement('strong'),sub=document.createElement('small');
    title.textContent=room.title;
    sub.textContent=room.type==='classroom'?`${room.desk_count || 36} 席 · 普通教室`
      :room.type==='office'?'教研与办公空间':`${room.total_stalls || 3} 个隔间 · 卫生设施`;
    label.append(title,sub); const arrow=document.createElement('span'); arrow.className='room-arrow'; arrow.textContent='↗';
    button.append(icon,label,arrow); button.addEventListener('click',()=>navigateRoom(room));
    $('roomList').appendChild(button);
  }
}

async function selectFloor(id,{isolate=false,move=false,internal=false}={}) {
  if(!booted) return;
  if(!internal) { stopTour(); cancelMotion(); }
  activeFloor=Number(id); hiddenFloors.delete(activeFloor);
  if(isolate) visibilityMode='floor';
  const token=++floorSelectionToken;
  renderRoomList(); syncVisibility();
  try {
    await Promise.all([ensureFurniture(activeFloor),ensureFloorStructure(activeFloor)]);
    if(token!==floorSelectionToken) return;
    if(move) {
      const level=floors.get(activeFloor).elevation;
      setLocation(null);
      if(mode==='walk') { camera.position.set(0,level+1.65,-5.15); footY=level; yaw=-Math.PI/2; pitch=0; }
      else {
        const target=[0,level+.9,0],overview=fitMobileOverview([35,level+27,-31],target,49,
          {min:[-32,level,-8],max:[32,level+3.6,8]});
        animateCamera(overview,target,850,49);
      }
    }
    syncVisibility();
  } catch(error) { showError(error,()=>selectFloor(id,{isolate,move,internal})); }
}

function setLocation(room,label) {
  currentRoom=room;
  $('locationPill').hidden=!room&&!label;
  $('locationText').textContent=label || (room ? `${floors.get(room.floor).name} / ${room.title}` : '');
  renderRoomList();
}

async function navigateRoom(room,internal=false) {
  if(!internal) stopTour();
  setMode('orbit',false); activeFloor=room.floor;
  visibilityMode='all'; hiddenFloors.delete(room.floor);
  await selectFloor(room.floor,{internal:true});
  if(!floors.get(room.floor).furniture) return;
  const [x,level,z]=room.origin;
  const position=room.type==='restroom'
    ? [room.doors?.[0]?.position?.[0] ?? x+room.width*.66,level+1.65,z-room.depth+1.02]
    : [x+room.width-.90,level+1.65,z-room.depth+1.02];
  const target=room.type==='classroom' ? [x+.12,level+1.75,z-4.6]
    :room.type==='office' ? [x+2.0,level+1.10,z-4.8] : [x+room.width*.45,level+1.1,z-2.1];
  setLocation(room);
  if(mobile) collapsePanel(true);
  return animateCamera(position,target,internal?1200:900,room.type==='restroom'?64:62);
}

function cancelMotion() {
  if(motion) { motion.resolve?.(false); motion=null; }
}
function animateCamera(position,target,duration=1000,fov=48) {
  cancelMotion();
  return new Promise(resolve=> {
    motion={from:camera.position.clone(),to:v3(position),targetFrom:controls.target.clone(),
            targetTo:v3(target),fovFrom:camera.fov,fovTo:fov,start:performance.now(),
            duration:reducedMotion?0:duration,resolve};
  });
}
async function exterior(internal=false) {
  if(!internal) stopTour();
  setMode('orbit',false); visibilityMode='all'; hiddenFloors.clear();
  $('roofToggle').checked=true; setLocation(null); syncVisibility();
  const preset=manifest.cameras?.find(c=>c.id==='02_Exterior_Oblique');
  const target=preset?.target || [0,8,0],fov=mobile?49:43;
  const position=fitMobileOverview(preset?.position || [-66,35,-67],target,fov);
  return animateCamera(position,target,1100,fov);
}

function stopTour() {
  if(!touring) return;
  touring=false; tourToken++;
  $('tourButton').classList.remove('running');
  $('tourButton').querySelector('span').textContent='自动参观';
}
async function startTour() {
  if(touring) { stopTour(); cancelMotion(); return; }
  if(!booted) return;
  touring=true; const token=++tourToken;
  $('tourButton').classList.add('running'); $('tourButton').querySelector('span').textContent='停止参观';
  setMode('orbit',false); if(mobile) collapsePanel(true);
  const firstRooms=manifest.roomData.filter(r=>r.floor===1);
  const steps=[
    {camera:'01_Exterior_Front',label:'北侧入口 / 教学楼正面'},
    {room:firstRooms.find(r=>r.type==='classroom')},
    {room:firstRooms.find(r=>r.type==='office')},
    {room:firstRooms.find(r=>r.type==='restroom'&&r.gender==='male')},
    {camera:'06_Stair_Corridor',floor:2,label:'二层 / 楼梯与走廊'},
    {camera:'08_Continuous_Corridor',floor:2,label:'二层 / 连续走廊'},
    {camera:'07_Campus_Aerial',label:'校园 / 建筑俯视'},
  ];
  try {
    let index=0;
    while(touring && token===tourToken) {
      const step=steps[index++%steps.length];
      if(step.room) await navigateRoom(step.room,true);
      else {
        if(step.floor) await selectFloor(step.floor,{internal:true});
        if(!touring||token!==tourToken) break;
        const preset=manifest.cameras.find(c=>c.id===step.camera);
        if(preset) {
          visibilityMode='all'; hiddenFloors.clear(); syncVisibility();
          setLocation(null,step.label);
          const fov=step.floor?62:(mobile?48:43);
          const position=step.floor?preset.position:fitMobileOverview(preset.position,preset.target,fov);
          await animateCamera(position,preset.target,1600,fov);
        }
      }
      if(!touring||token!==tourToken) break;
      await new Promise(resolve=>setTimeout(resolve,5200));
    }
  } catch(e) { stopTour(); showError(e,startTour); }
}

function collapsePanel(value) {
  $('explorePanel').classList.toggle('collapsed',value);
  $('panelHandle').setAttribute('aria-expanded',String(!value));
}

function setMode(next,notify=true) {
  if(!camera) return;
  if(next==='walk' && !booted) return;
  // A quick tap on Walk after choosing a room should finish that room's
  // camera transition rather than resetting the visitor to the outdoor entry.
  if(notify && next==='walk' && currentRoom && motion) {
    camera.position.copy(motion.to); controls.target.copy(motion.targetTo);
    camera.lookAt(controls.target);
  }
  if(notify) { stopTour(); cancelMotion(); }
  if(mode===next) return;
  mode=next; controls.enabled=mode==='orbit';
  $('app').classList.toggle('walking',mode==='walk'); $('app').dataset.mode=mode;
  $('orbitMode').classList.toggle('active',mode==='orbit'); $('walkMode').classList.toggle('active',mode==='walk');
  for(const id of ['walkHints','crosshair','joystick','touchLookHint']) $(id).hidden=mode!=='walk';
  keys.clear(); joystick.x=joystick.y=0; resetJoystick();
  if(mode==='walk') {
    visibilityMode='all'; hiddenFloors.clear(); syncVisibility();
    const inside=Math.abs(camera.position.x)<31.2 && Math.abs(camera.position.z)<6.8;
    if(!inside) {
      // The real public entrance is centred on x=-4.3, on the north side.
      camera.position.set(-4.3,1.65,-11.6); camera.lookAt(-4.3,1.65,-4.5); footY=0;
      setLocation(null,'入口 / 步行探索');
    } else {
      const nearest=floors.get(activeFloor).elevation;
      footY=nearest; camera.position.y=footY+1.65;
    }
    camera.getWorldDirection(direction);
    yaw=Math.atan2(-direction.x,-direction.z); pitch=Math.asin(clamp(direction.y,-1,1));
    camera.rotation.order='YXZ'; camera.fov=67; camera.updateProjectionMatrix();
    if(mobile) collapsePanel(true);
    if(notify) toast(mobile?'左侧摇杆移动，右侧画面拖动转向':'单击画面后使用 W A S D 移动；Esc 可释放鼠标');
    ensureFurniture(activeFloor).catch(e=>showError(e,()=>ensureFurniture(activeFloor)));
  } else {
    document.exitPointerLock?.();
    camera.getWorldDirection(direction); controls.target.copy(camera.position).addScaledVector(direction,4);
    camera.rotation.order='XYZ'; controls.update();
  }
}

function bodyIntersects(bounds,x,z,ground) {
  const min=bounds.min,max=bounds.max,r=.18;
  if(max[1]<ground+.09 || min[1]>ground+1.79) return false;
  return x>min[0]-r && x<max[0]+r && z>min[2]-r && z<max[2]+r;
}

function surfaceHeight(x,z,previous) {
  const inside=Math.abs(x)<31.2 && z>-6.92 && z<6.90;
  if(!inside) {
    if(previous>1.05) return null; // Upper storeys cannot walk into open air.
    if(x< -88 || x>88 || z< -63 || z>63) return null;
    // Smooth foot-height equivalent of the entrance approach and three steps.
    if(x> -6.05 && x< -2.55 && z> -9.6 && z< -6.6)
      return clamp((z+9.6)/2.7,0,1)*.45;
    return 0;
  }
  const stairX=x< -25.8 ? -31.4 : x>25.8 ? 25.8 : null;
  const levels=[...floors.values()].map(f=>f.elevation);
  if(stairX!==null && z> -2.82) {
    const local=x-stairX;
    if(z>1.56 || local<.29 || local>5.29) return null;
    const candidates=[];
    for(let i=0;i<levels.length-1;i++) {
      const base=levels[i];
      if(z>=.28) candidates.push(base+1.8);
      else if(local>=.55 && local<=2.14)
        candidates.push(base+clamp((z+2.8)/3.08,0,1)*1.8);
      else if(local>=2.90 && local<=4.49)
        candidates.push(base+1.8+clamp((.28-z)/3.08,0,1)*1.8);
    }
    if(!candidates.length) return null;
    const closest=candidates.reduce((a,b)=>Math.abs(a-previous)<Math.abs(b-previous)?a:b);
    return Math.abs(closest-previous)<.34 ? closest : null;
  }
  return levels.reduce((a,b)=>Math.abs(a-previous)<Math.abs(b-previous)?a:b);
}

function canWalk(x,z,previous) {
  const ground=surfaceHeight(x,z,previous);
  if(ground===null || Math.abs(ground-previous)>.34) return null;
  for(const f of floors.values()) {
    // Vertical filtering preserves real lintels, sills and stair openings.
    if(Math.abs(f.elevation-ground)>3.4) continue;
    for(const wall of f.wallColliders || []) if(bodyIntersects(wall.bounds,x,z,ground)) return null;
  }
  for(const wall of externalColliders) {
    // Roof parapets and entry columns are valid colliders; horizontal bases
    // below ankle level are ignored by the capsule-height test above.
    if(bodyIntersects(wall.bounds,x,z,ground)) return null;
  }
  return ground;
}

function moveWalk(delta) {
  let forward=(keys.has('KeyW')||keys.has('ArrowUp')?1:0)-(keys.has('KeyS')||keys.has('ArrowDown')?1:0)-joystick.y;
  let side=(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0)+joystick.x;
  const length=Math.hypot(forward,side);
  if(length>1) { forward/=length; side/=length; }
  const speed=(keys.has('ShiftLeft')||keys.has('ShiftRight')?4.0:2.35)*delta;
  const dx=(-Math.sin(yaw)*forward+Math.cos(yaw)*side)*speed;
  const dz=(-Math.cos(yaw)*forward-Math.sin(yaw)*side)*speed;
  // Small independent-axis steps allow sliding against a wall without tunnelling.
  const pieces=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.06));
  for(let i=0;i<pieces;i++) {
    let height=canWalk(camera.position.x+dx/pieces,camera.position.z,footY);
    if(height!==null) { camera.position.x+=dx/pieces; footY=height; }
    height=canWalk(camera.position.x,camera.position.z+dz/pieces,footY);
    if(height!==null) { camera.position.z+=dz/pieces; footY=height; }
  }
  camera.position.y=THREE.MathUtils.damp(camera.position.y,footY+1.65,18,delta);
  camera.rotation.set(pitch,yaw,0,'YXZ');
  const candidate=[...floors.values()].filter(f=>f.elevation<=footY+.27).at(-1);
  if(candidate && candidate.id!==activeFloor) {
    activeFloor=candidate.id; renderRoomList(); syncVisibility();
    ensureFurniture(activeFloor).catch(e=>showError(e,()=>ensureFurniture(activeFloor)));
    setLocation(null,`${candidate.name} / 步行导览`);
  }
}

function resetJoystick() { $('joystickKnob').style.transform='translate(0,0)'; }
function enablePointerFallback() {
  if(mode!=='walk'||mobile||pointerLookFallback)return;
  pointerLookFallback=true;lookTouch.id=null;
  toast('浏览器未启用鼠标锁定；按住画面拖动转向，使用 W A S D 移动');
}
function bindMovement() {
  addEventListener('keydown',event=> {
    if(mode!=='walk'||event.target.matches('input,select,textarea')) return;
    if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight'].includes(event.code)) {
      event.preventDefault(); keys.add(event.code);
    }
  });
  addEventListener('keyup',event=>keys.delete(event.code));
  addEventListener('blur',()=> { keys.clear(); joystick.x=joystick.y=0;joystick.pointer=null;lookTouch.id=null;resetJoystick(); });
  document.addEventListener('visibilitychange',()=> { keys.clear(); lastTime=performance.now(); });
  renderer.domElement.addEventListener('click',()=> {
    if(mode!=='walk'||mobile||pointerLookFallback)return;
    if(typeof renderer.domElement.requestPointerLock!=='function'){
      enablePointerFallback();return;
    }
    try {
      const request=renderer.domElement.requestPointerLock();
      if(request&&typeof request.catch==='function')request.catch(enablePointerFallback);
    } catch { enablePointerFallback(); }
  });
  document.addEventListener('pointerlockerror',enablePointerFallback);
  document.addEventListener('pointerlockchange',()=> {
    if(document.pointerLockElement===renderer.domElement)pointerLookFallback=false;
  });
  document.addEventListener('mousemove',event=> {
    if(mode==='walk'&&document.pointerLockElement===renderer.domElement) {
      yaw-=event.movementX*.0021; pitch=clamp(pitch-event.movementY*.0021,-1.35,1.35);
    }
  });
  renderer.domElement.addEventListener('pointerdown',event=> {
    if(mode!=='walk'||(!mobile&&!pointerLookFallback)||lookTouch.id!==null) return;
    // The separate joystick owns movement; the scene owns the look gesture.
    lookTouch.id=event.pointerId; lookTouch.x=event.clientX; lookTouch.y=event.clientY;
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener('pointermove',event=> {
    if(mode!=='walk'||lookTouch.id!==event.pointerId) return;
    yaw-=(event.clientX-lookTouch.x)*.004;
    pitch=clamp(pitch-(event.clientY-lookTouch.y)*.004,-1.35,1.35);
    lookTouch.x=event.clientX; lookTouch.y=event.clientY;
  });
  const endLook=event=> { if(lookTouch.id===event.pointerId) lookTouch.id=null; };
  renderer.domElement.addEventListener('pointerup',endLook);
  renderer.domElement.addEventListener('pointercancel',endLook);
  renderer.domElement.addEventListener('lostpointercapture',endLook);
  const stick=$('joystick');
  function updateStick(event) {
    const rect=stick.getBoundingClientRect(),radius=rect.width*.36;
    let x=event.clientX-rect.left-rect.width/2,y=event.clientY-rect.top-rect.height/2;
    const len=Math.hypot(x,y); if(len>radius){x*=radius/len;y*=radius/len;}
    joystick.x=x/radius;joystick.y=y/radius;
    $('joystickKnob').style.transform=`translate(${x}px,${y}px)`;
  }
  stick.addEventListener('pointerdown',event=> {
    if(mode!=='walk'||joystick.pointer!==null)return;
    event.preventDefault(); joystick.pointer=event.pointerId; stick.setPointerCapture(event.pointerId); updateStick(event);
  });
  stick.addEventListener('pointermove',event=> { if(event.pointerId===joystick.pointer)updateStick(event); });
  const endStick=event=> { if(event.pointerId!==joystick.pointer)return; joystick.pointer=null;joystick.x=joystick.y=0;resetJoystick(); };
  stick.addEventListener('pointerup',endStick);stick.addEventListener('pointercancel',endStick);stick.addEventListener('lostpointercapture',endStick);
}

function updateMarkers() {
  if(!manifest) return;
  camera.getWorldDirection(direction);
  const interior=Math.abs(camera.position.x)<31.4&&Math.abs(camera.position.z)<7.2;
    const floorLevel=floors.get(activeFloor)?.elevation || .45;
    const show=mode==='orbit'&&!interior&&camera.position.distanceTo(controls.target)<105
      && (visibilityMode==='floor'||Math.abs(camera.position.y-floorLevel)<5);
  const width=$('viewport').clientWidth,height=$('viewport').clientHeight;
  for(const item of markerItems) {
    let visible=show && item.room.floor===activeFloor && !hiddenFloors.has(activeFloor);
    if(visible) {
      projected.copy(item.position).sub(camera.position);
      visible=projected.dot(direction)>0;
      projected.copy(item.position).project(camera);
      visible=visible&&Math.abs(projected.x)<.98&&Math.abs(projected.y)<.94&&projected.z<1;
    }
    item.element.hidden=!visible;
    if(visible) { item.element.style.left=`${(projected.x*.5+.5)*width}px`;item.element.style.top=`${(-projected.y*.5+.5)*height}px`; }
  }
}

function updateDetailLOD() {
  const record=floors.get(activeFloor); if(!record?.furniture) return;
  const p=camera.position;
  const inside=Math.abs(p.x)<32 && Math.abs(p.z)<8 && p.y<record.elevation+4;
  const close=p.distanceTo(new THREE.Vector3(0,record.elevation+1.5,0))<66;
  record.furniture.visible=inside||close||$('distantFurniture').checked;
}

function frame(now) {
  if(destroyed||!renderer) return;
  if(document.hidden){lastTime=now;return;}
  const delta=Math.min((now-lastTime)/1000,.045);lastTime=now;
  if(mode==='walk')moveWalk(delta);
  else if(motion) {
    const t=motion.duration===0?1:clamp((now-motion.start)/motion.duration,0,1);
    const eased=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
    camera.position.lerpVectors(motion.from,motion.to,eased);
    controls.target.lerpVectors(motion.targetFrom,motion.targetTo,eased);
    camera.fov=THREE.MathUtils.lerp(motion.fovFrom,motion.fovTo,eased);camera.updateProjectionMatrix();
    if(t===1){const resolve=motion.resolve;motion=null;resolve(true);}
  }
  if(mode==='orbit')controls.update();
  updateDetailLOD();updateMarkers();
  camera.getWorldDirection(direction);
  const compassAngle=Math.atan2(direction.x,-direction.z);
  $('compassNeedle').style.transform=`rotate(${-compassAngle}rad)`;
  renderer.render(scene,camera); measuredFrames++;
  if(now-lastMeasure>=800) {
    const fps=measuredFrames*1000/(now-lastMeasure);
    fpsHistory.push(Number(fps.toFixed(1)));if(fpsHistory.length>10)fpsHistory.shift();totalFpsSamples++;
    $('perfFps').textContent=`${fps.toFixed(0)} FPS`;
    $('perfCalls').textContent=`${renderer.info.render.calls} 次绘制`;
    $('perfTriangles').textContent=`${(renderer.info.render.triangles/1000).toFixed(0)}k 三角形`;
    $('perfMemory').textContent=`${renderer.info.memory.geometries} 几何 / ${renderer.info.memory.textures} 贴图`;
    $('performance').dataset.fps=fps.toFixed(1);
    $('performance').dataset.calls=String(renderer.info.render.calls);
    $('performance').dataset.triangles=String(renderer.info.render.triangles);
    $('performance').dataset.fpsHistory=JSON.stringify(fpsHistory);
    $('performance').dataset.sampleCount=String(fpsHistory.length);
    $('performance').dataset.totalSamples=String(totalFpsSamples);
    const appState=$('app').dataset;
    appState.loadedShells=[...floors.values()].filter(f=>f.shellObject).map(f=>f.id).join(',');
    appState.loadedFullFloors=[...floors.values()].filter(f=>f.structure).map(f=>f.id).join(',');
    appState.builtFurnitureFloors=[...floors.values()].filter(f=>f.furniture).map(f=>f.id).join(',');
    appState.loadedOpenings=[...floors.values()].filter(f=>f.openings).map(f=>f.id).join(',');
    appState.camera=JSON.stringify(camera.position.toArray().map(n=>Number(n.toFixed(4))));
    appState.footY=String(Number(footY.toFixed(4)));
    appState.pointerLook=mobile?'touch':pointerLookFallback?'drag':document.pointerLockElement===renderer.domElement?'locked':'click-to-lock';
    measuredFrames=0;lastMeasure=now;
  }
}

async function toggleFullscreen() {
  try {
    if(document.fullscreenElement||document.webkitFullscreenElement) {
      if(document.exitFullscreen)await document.exitFullscreen();else document.webkitExitFullscreen?.();
    } else if($('app').requestFullscreen) await $('app').requestFullscreen();
    else if($('app').webkitRequestFullscreen) $('app').webkitRequestFullscreen();
    else {
      $('app').classList.toggle('pseudo-fullscreen');scrollTo(0,0);
      toast('已扩展为全屏布局；Safari 地址栏由浏览器管理');resize();
    }
  } catch {
    $('app').classList.toggle('pseudo-fullscreen');resize();
    toast('浏览器限制系统全屏，已切换为完整窗口布局');
  }
}

function bindUI() {
  $('orbitMode').addEventListener('click',()=>setMode('orbit'));
  $('walkMode').addEventListener('click',()=>setMode('walk'));
  $('exteriorButton').addEventListener('click',()=>exterior());
  document.querySelector('.brand').addEventListener('click',event=> {event.preventDefault();if(booted)exterior();});
  $('closeLocation').addEventListener('click',()=>exterior());
  $('showAll').addEventListener('click',()=> {stopTour();visibilityMode='all';hiddenFloors.clear();syncVisibility();});
  $('roofToggle').addEventListener('change',syncVisibility);
  $('hideFloor').addEventListener('click',()=> {
    stopTour();
    if(hiddenFloors.has(activeFloor))hiddenFloors.delete(activeFloor);else hiddenFloors.add(activeFloor);
    syncVisibility();
  });
  $('panelHandle').addEventListener('click',()=> {if(mobile)collapsePanel(!$('explorePanel').classList.contains('collapsed'));});
  $('tourButton').addEventListener('click',startTour);
  $('qualitySelect').addEventListener('change',event=>applyQuality(event.target.value));
  $('statsToggle').addEventListener('change',()=> {$('performance').hidden=!$('statsToggle').checked;});
  $('settingsButton').addEventListener('click',()=> {
    $('settingsPanel').hidden=!$('settingsPanel').hidden;
    $('settingsButton').setAttribute('aria-expanded',String(!$('settingsPanel').hidden));
  });
  $('closeSettings').addEventListener('click',()=> {$('settingsPanel').hidden=true;$('settingsButton').setAttribute('aria-expanded','false');});
  $('fullscreenButton').addEventListener('click',toggleFullscreen);
  $('infoButton').addEventListener('click',()=> {$('infoDialog').showModal();});
  $('retryButton').addEventListener('click',async()=> {
    $('retryButton').disabled=true;$('errorPanel').hidden=true;
    try{await retryOperation?.();}catch(e){showError(e,retryOperation);}
    finally{$('retryButton').disabled=false;}
  });
  addEventListener('keydown',event=> {
    if(event.code==='Escape') {
      if(touring){stopTour();cancelMotion();}
      $('settingsPanel').hidden=true;
      if($('app').classList.contains('pseudo-fullscreen'))$('app').classList.remove('pseudo-fullscreen');
    }
  });
}

async function boot() {
  bindUI();
  try {
    makeRenderer();bindMovement();
    manifest=await json('./assets/manifest.json','模型清单');
    if(!manifest.floors?.length)throw new Error('模型清单未包含楼层。');
    for(const specification of manifest.floors) {
      const group=new THREE.Group();group.name=`Floor_${specification.id}`;scene.add(group);
      floors.set(Number(specification.id),{...specification,id:Number(specification.id),group,
        wallColliders:[],lastUsed:0,structure:null,openings:null,furniture:null});
    }
    activeFloor=Number(manifest.floors[0].id);
    const source=manifest.source || {};
    $('sourceLine').textContent=`来源：ChineseSchool V1 Blender ${source.blender || ''} · Web ${manifest.version || '1.1'} · SHA-256 ${(source.sha256 || '未提供').slice(0,16)}`;
    buildNavigation();
    await Promise.all([
      ...manifest.environment.map(spec=>loadEnvironment(spec)),
      ...manifest.floors.map(spec=>ensureFloorShell(spec.id)),
      ...manifest.floors.map(spec=>ensureOpenings(spec.id)),
    ]);
    booted=true;$('app').dataset.ready='true';$('app').dataset.mode='orbit';
    $('sceneStatus').textContent='完整建筑 / 米制模型';
    $('loading').classList.add('leaving');setTimeout(()=>{$('loading').hidden=true;},550);
    if(mobile)collapsePanel(true);
    ensureFurniture(activeFloor).catch(e=>showError(e,()=>ensureFurniture(activeFloor)));
    // Five lightweight shells and opening batches form the complete facade.
    // Full architectural details and furniture are streamed for one floor only.
    backgroundBoot=false;updateProgress();
    $('sceneStatus').textContent='五层教学楼 / 自由探索';
    window.schoolViewer={
      getSnapshot:()=>({ready:booted,mode,activeFloor,visibilityMode,quality,
        loadedStructures:[...floors.values()].filter(f=>f.structure).map(f=>f.id),
        loadedShells:[...floors.values()].filter(f=>f.shellObject).map(f=>f.id),
        builtFurnitureFloors:[...floors.values()].filter(f=>f.furniture).map(f=>f.id),
        loadedOpenings:[...floors.values()].filter(f=>f.openings).map(f=>f.id),
        camera:camera.position.toArray(),footY,
        actualRender:{calls:renderer.info.render.calls,triangles:renderer.info.render.triangles},
        sourceSha256:manifest.source?.sha256}),
      selectFloor:id=>selectFloor(id,{isolate:true,move:true}),
      navigateRoom:id=> {const room=manifest.roomData.find(r=>r.id===id);return room?navigateRoom(room):Promise.reject(new Error('Room not found'));},
      exterior:()=>exterior(),setMode,
    };
  } catch(error) {showError(error,()=>location.reload(),!booted);}
}

// Dispose shared resources once, after every instance has been detached.
addEventListener('pagehide',event=> {
  if(event.persisted)return;
  destroyed=true;stopTour();cancelMotion();renderer?.setAnimationLoop(null);
  const geometries=new Set(),materials=new Set(),textures=new Set();
  for(const f of floors.values())releaseFurniture(f);
  for(const root of [scene,prototypeScene]) root?.traverse(object=> {
    if(object.geometry)geometries.add(object.geometry);
    for(const material of Array.isArray(object.material)?object.material:[object.material]) {
      if(!material)continue;materials.add(material);
      Object.values(material).forEach(value=>{if(value?.isTexture)textures.add(value);});
    }
    if(object.isInstancedMesh)object.dispose();
  });
  textures.forEach(t=>t.dispose());materials.forEach(m=>m.dispose());geometries.forEach(g=>g.dispose());
  controls?.dispose();renderer?.dispose();
});

boot();
