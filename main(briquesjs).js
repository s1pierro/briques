/* starter file for three.js pwa */
//import ollama from 'ollama/browser';
var textdata = [
  {
    ref: 'forge-help',
    fr : 'Dans la forge vous pouvez enrichir vos objets 3D de différentes propriétées, principalement celle appelée slot.<br> Les slots sont composés d\'une position,  d\'un vecteur axe de référence, dû ou des indices des différentes surfaces qui le composent et d\'un type. ces surface permettront par la suite d\'assembler ces slots les uns aux autres afin de former différentes liaisons lors de la phase d\'assemblage ',
    en : 'In the forge, you can enrich your 3D objects with different properties, mainly the one called slot. Slots are composed of a position, a reference axis vector, one or more indices of the different surfaces that make it up, and a type. These surfaces will later allow these slots to be assembled together to form different connections during the assembly phase.'
  }
  
  ]
var renderheight = 1;
function createAlignmentMatrix(vector1, vector2) {
  // Normaliser les vecteurs
  vector1.normalize();
  vector2.normalize();

  // Calculer l'angle de rotation entre les deux vecteurs
  let angle = vector1.angleTo(vector2);

  // Vérifier si les vecteurs sont colinéaires
  if (angle === 0) {
    // Les vecteurs sont déjà alignés
    return new THREE.Matrix4();
  }

  // Calculer l'axe de rotation entre les deux vecteurs
  let axis = new THREE.Vector3().crossVectors(vector1, vector2).normalize();

  // Vérifier si les vecteurs sont de même sens
  if (axis.length() === 0) {
    // Les vecteurs sont de même sens, donc il n'y a pas d'axe de rotation défini
    // Nous allons donc créer une matrice qui retourne les vecteurs en miroir l'un par rapport à l'autre
    return new THREE.Matrix4().makeScale(-1, 1, 1);
  }

  // Créer une matrice de rotation pour aligner les deux vecteurs
  return new THREE.Matrix4().makeRotationAxis(axis, angle);
}
function getApparentHeight(object, camera, renderer) {
    // Obtenir les dimensions du renderer
    const rendererSize = renderer.getSize(new THREE.Vector2());

    // Calculer les coordonnées 3D des coins supérieur et inférieur de l'objet
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());

    const top = new THREE.Vector3(box.max.x, box.max.y, box.max.z);
    const bottom = new THREE.Vector3(box.min.x, box.min.y, box.min.z);

    // Convertir les coordonnées 3D en coordonnées 2D
    const topProjected = top.project(camera);
    const bottomProjected = bottom.project(camera);

    // Convertir les coordonnées normalisées [-1, 1] en pixels
    const topY = ((1 - topProjected.y) / 2) * rendererSize.y;
    const bottomY = ((1 - bottomProjected.y) / 2) * rendererSize.y;

    // Calculer la hauteur apparente en pixels
    const apparentHeight = Math.abs(bottomY - topY);
    return apparentHeight;
}
function createSlider(ranges) {
  // Création du conteneur principal
  const sliderContainer = document.createElement("div");
  sliderContainer.classList.add("slider-container");

  // Création du curseur
  const cursor = document.createElement("div");
  cursor.classList.add("slider-cursor");
  sliderContainer.appendChild(cursor);

  // Création des éléments représentant les différentes propriétés range
  ranges.forEach((range) => {
    const rangeElement = document.createElement("div");
    rangeElement.classList.add("slider-range");
    rangeElement.style.left = ((range.from / 100) * sliderContainer.offsetWidth) + "px";
    rangeElement.style.width = (((range.to - range.from) / 100) * sliderContainer.offsetWidth) + "px";
    sliderContainer.appendChild(rangeElement);
  });

  return sliderContainer;
}
function createMatrixRotationButtons(matrix, mesh) {
  
  const position = new THREE.Vector3().setFromMatrixPosition(matrix);
  // On crée un élément <div> pour contenir les boutons
  const container = document.createElement('div');

  // On crée un bouton pour chaque axe (x, y et z)
  const btnX = document.createElement('button');
  btnX.textContent = 'Rot X +90°';
  btnX.addEventListener('click', () => {
    const quat = new THREE.Quaternion().setFromRotationMatrix(matrix);
    quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
    matrix.makeRotationFromQuaternion(quat);
    matrix.setPosition(position);
    if (mesh) {
      mesh.matrix.makeRotationFromQuaternion(quat);
      mesh.matrix.setPosition(position);
      app.allunits.render();
    }
  });

  const btnY = document.createElement('button');
  btnY.textContent = 'Rot Y +90°';
  btnY.addEventListener('click', () => {
    const quat = new THREE.Quaternion().setFromRotationMatrix(matrix);
    quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)));
    matrix.makeRotationFromQuaternion(quat);
    matrix.setPosition(position);
    if (mesh) {
      mesh.matrix.makeRotationFromQuaternion(quat);
      mesh.matrix.setPosition(position);
      app.allunits.render();
    }
  });

  const btnZ = document.createElement('button');
  btnZ.textContent = 'Rot Z +90°';
  btnZ.addEventListener('click', () => {
    const quat = new THREE.Quaternion().setFromRotationMatrix(matrix);
    quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)));
    matrix.makeRotationFromQuaternion(quat);
    matrix.setPosition(position);
    if (mesh) {
      mesh.matrix.makeRotationFromQuaternion(quat);
      mesh.matrix.setPosition(position);
      app.allunits.render();
    }
  });

  // On ajoute les boutons au conteneur
  container.appendChild(btnX);
  container.appendChild(btnY);
  container.appendChild(btnZ);

  // On retourne le conteneur
  return container;
}
function createMatrixPositionInputs(matrix, mesh, label) {
  const position = new THREE.Vector3().setFromMatrixPosition(matrix); // On récupère la composante de position de la matrice
  
  // On crée un élément <div> pour contenir les champs de saisie
  const container = createDiv(label, 'coordinputline');
  //container.classList.add('coordinputline')
  // On crée trois champs de saisie pour les coordonnées x, y et z
  const inputX = document.createElement('input');
  inputX.type = 'number';
  inputX.value = position.x;
  inputX.addEventListener('change', () => {
    position.x = parseFloat(inputX.value);
    matrix.setPosition(position);
    if (mesh) {
      
      mesh.matrix.setPosition(position);
      app.allunits.render();
    }
    
  });
  //inputX.style.border = 'none';
  inputX.style.borderLeft = '1em solid #f00'
  
  const inputY = document.createElement('input');
  inputY.type = 'number';
  inputY.value = position.y;
  inputY.addEventListener('change', () => {
    position.y = parseFloat(inputY.value);
    matrix.setPosition(position);
    if (mesh) {
      
      mesh.matrix.setPosition(position);
      app.allunits.render();
    }
  });
 // inputY.style.border = 'none';
  inputY.style.borderLeft = '1em solid #0f0';

  const inputZ = document.createElement('input');
  inputZ.type = 'number';
  inputZ.value = position.z;
  inputZ.addEventListener('change', () => {
    position.z = parseFloat(inputZ.value);
    matrix.setPosition(position);
        if (mesh) {
      
      mesh.matrix.setPosition(position);
      app.allunits.render();
    }
  });
  //inputZ.style.border = 'none';
  inputZ.style.borderLeft = '1em solid #00f';
  // On ajoute les champs de saisie au conteneur
  container.appendChild(inputX);
  container.appendChild(inputY);
  container.appendChild(inputZ);
  
  // On retourne le conteneur
  return container;
}
function getGroupIndices(mesh, refMaterialIndex) {
  const geometry = mesh.geometry;

  if (!(geometry instanceof THREE.BufferGeometry)) {
    console .warn('La géométrie du maillage doit être de type BufferGeometry pour pouvoir accéder aux groupes.');
    return [];
  }

  const groupIndices = [];
  const groups = geometry.groups;
  
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group.materialIndex === refMaterialIndex) {
      groupIndices.push(i);
    }
  }

  return groupIndices;
}
function removeChildren(mesh) {
  while (mesh.children.length) {
    mesh.remove(mesh.children[0]);
  }
}
function getJSON(url, callback) {
  const loader = createDiv("");
  loader.style.position = "fixed";
  loader.style.top = "50%";
  loader.style.left = "50%";
  loader.style.width = "50vw";
  loader.style.height = "50vw";
  loader.style.backgroundColor = "#fffd";
  loader.style.zIndex = "9999";
  loader.style.borderRadius = "5vw";
  loader.style.display = "flex";
  loader.style.transform = "translate(-50%, -50%)";
  loader.classList.add('load-indicator');
  loader.style.justifyContent = "center";
  loader.style.alignItems = "center";
  loader.innerHTML = "<div style='width: 50px; height: 50px; border: 5px solid #0072c6; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite;'></div>";
  document.body.appendChild(loader);

  const xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4 && xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      document.body.removeChild(loader);
      callback(data);
    }
  };
  xhr.open("GET", url);
  xhr.send();
}
class Slot {
 // object and json data affering to slots ...
  constructor(params) {
  //brickuid, type, mat, surfaces, name) {
  this.surfaces = [...params.surfaces];
  this.mat = new THREE.Matrix4().fromArray(params.mat.elements);
  this.bmat = params.bmat;
//  this.bmat = new THREE.Matrix4().fromArray(params.bmat.elements);
  this.uid = '#slot-'+generateHexString(16);
  this.type = params.type;
  this.brickuid = params.brickuid;
  
  this.xrepeat = (params.xrepeat) ? params.xrepeat : 0;
  this.yrepeat = (params.yrepeat) ? params.yrepeat : 0;
  this.xrepeatinc = (params.xrepeatinc) ? params.xrepeatinc : 0;
  this.yrepeatinc = (params.yrepeatinc) ? params.yrepeatinc : 0;
  this.index = params.index;
  this.fmat= this.getfmat();
  this.position = new THREE.Vector3().setFromMatrixPosition(this.fmat);
  }
  getfmat() {
  this.fmat = new THREE.Matrix4().multiplyMatrices(this.mat, this.bmat);
  this.position = new THREE.Vector3().setFromMatrixPosition(this.fmat);
  return this.fmat
  }
  updatefmat() {
  this.fmat = new THREE.Matrix4().multiplyMatrices(this.bmat, this.mat);
  this.position = new THREE.Vector3().setFromMatrixPosition(this.fmat);
  }
  isColinear (slot) {
    this.updatefmat();
    slot.updatefmat();
    let matrix1 = this.fmat;
    
    let matrix2 = slot.fmat;
    
// Supposons que vous ayez deux matrices de transformation 4x4 pour les slots nommées matrix1 et matrix2

// Obtenez les vecteurs d'axes Y des deux slots
const axisY1 = new THREE.Vector3();
const axisY2 = new THREE.Vector3();

axisY1.setFromMatrixColumn(matrix1, 1).normalize();
axisY2.setFromMatrixColumn(matrix2, 1).normalize();

// Comparez les vecteurs d'axes Y pour vérifier s'ils sont colinéaires
const colinearThreshold = 0.99; // Seuil de colinéarité (à ajuster selon vos besoins)
const areSlotsColinear = axisY1.dot(axisY2) > colinearThreshold;

// Vérifiez si l'origine de l'un des slots est alignée avec la droite passant par l'axe Y de l'autre slot
const origin1 = new THREE.Vector3().setFromMatrixPosition(this.fmat);
const origin2 = new THREE.Vector3().setFromMatrixPosition(slot.fmat);;
/*const quat1 = new THREE.Quaternion();
const quat2 = new THREE.Quaternion();
const scale1 = new THREE.Vector3();
const scale2 = new THREE.Vector3();*/
//console.log(this);
//console.log(this.fmat);
//this.fmat.decompose(origin1, quat1, scale1);
//matrix2.decompose(origin2, quat2, scale2)
origin2.applyMatrix4(matrix1.invert());
console.log(origin1);
console.log(origin2);

origin2.setY(0);




if (origin2.distanceTo(new THREE.Vector3())< 1) {
  console.log("Les slots sont colinéaires le long de l'axe Y avec une origine alignée.");
  
  app.units[0].addcrosscursor(new THREE.Vector3(), this, 5);
  return true;
} else {
//console.log(origin2);
  //console.log("pas colinéaires.");
  app.units[0].addcrosscursor(new THREE.Vector3(), this);
  true
}

    return false
  }
}
class Brick {
  constructor(bdid) {
   
    this.object = {};
    this.slots =[];
    this.mat = null;
    this.name = 'brick';
    this.color = '#555';
    this.uid = '#brick-'+generateHexString(6);
    this.mesh = null;
  }
  exportToJson () {
    for (let i = 0; i < this.slots.length; i++) {
        this.slots[i].clippedto = undefined;
      }
    let tmp = {
      object: this.object,
      slots: [...this.slots],
      name: this.name,
      color: this.color
    }
    console.log (tmp);
    return tmp;
    
  }
  loadfromJson (json) {
    let tmp = json;

    this.object = tmp.object;
    
    for (let r = 0; r < tmp.object.surfaces.length; r++) {
    let cnt = 0;
      let surface = tmp.object.surfaces[r];
    
        let p = new THREE.Vector3();
        for (let q = 0; q < surface.triangleset.length; q++) {
          let i = surface.triangleset[q];
        
        for (let s = 0; s < 3; s++) {
          let vf = 
         tmp.object.triangles[surface.triangleset[q]][s];
          p.x +=  tmp.object.vertices[vf][0];
          p.y +=  tmp.object.vertices[vf][1];
          p.z +=  tmp.object.vertices[vf][2];
          cnt++
        }
          
        }
        p.x /= cnt;
        p.y /= cnt;
        p.z /= cnt; 

        tmp.object.surfaces[r].position = p;
    }
    this.mesh = computemesh(this.object);
    for (let i = 0; i < tmp.slots.length; i++) {
      let params = {
        type: tmp.slots[i].type,
        mat: new THREE.Matrix4().fromArray(tmp.slots[i].mat.elements),
        bmat: this.mesh.matrix,
        brickuid: this.uid,
        xrepeat: tmp.slots[i].xrepeat,
        yrepeat: tmp.slots[i].yrepeat,
        xrepeatinc: tmp.slots[i].xrepeatinc,
        yrepeatinc: tmp.slots[i].yrepeatinc,
        surfaces: tmp.slots[i].surfaces,
        index: this.slots.length
      }
      this.slots.push(new Slot(params));
    
    }
    this.uid = '#brick-'+generateHexString(16);
    
    this.mesh.isBrick = true;
    this.about = 'une brique ABS celebre..';
    if (tmp.color)
      this.color = tmp.color;
    this.mesh.material[0].color.set(this.color);
      this.name = tmp.name;
    return this;
  }
  loadfromJson2 (json) {
    let tmp = json;

    this.object = tmp.object;
    
    for (let r = 0; r < tmp.object.surfaces.length; r++) {
    let cnt = 0;
      let surface = tmp.object.surfaces[r];
    
        let p = new THREE.Vector3();
        for (let q = 0; q < surface.triangleset.length; q++) {
          let i = surface.triangleset[q];
        
        for (let s = 0; s < 3; s++) {
          let vf = 
         tmp.object.triangles[surface.triangleset[q]][s];
          p.x +=  tmp.object.vertices[vf][0];
          p.y +=  tmp.object.vertices[vf][1];
          p.z +=  tmp.object.vertices[vf][2];
          cnt++
        }
          
        }
        p.x /= cnt;
        p.y /= cnt;
        p.z /= cnt; 

        tmp.object.surfaces[r].position = p;
    }
    this.slots = tmp.slots;
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i].mat = new THREE.Matrix4().fromArray(this.slots[i].mat.elements);
      this.slots[i].index = i;
    }
    this.uid = '#-'+generateHexString(16);
    this.mesh = computemesh(this.object);
    this.mesh.isBrick = true;
    this.about = 'une brique ABS celebre..';
    if (tmp.color)
      this.color = tmp.color;
    this.mesh.material[0].color.set(this.color);
    
      this.name = tmp.name;
    return this;
    
  }
  loadfromHtml (bdid) {
    this.object = loadWavefrontFromHTLM(bdid);
    
    for (let r = 0; r < this.object.surfaces.length; r++) {
    let cnt = 0;
      let surface = this.object.surfaces[r];
    
        let p = new THREE.Vector3();
        for (let q = 0; q < surface.triangleset.length; q++) {
          let i = surface.triangleset[q];
        
        for (let s = 0; s < 3; s++) {
          let vf = 
         this.object.triangles[surface.triangleset[q]][s];
          p.x +=  this.object.vertices[vf][0];
          p.y +=  this.object.vertices[vf][1];
          p.z +=  this.object.vertices[vf][2];
          cnt++
        }
          
        }
        p.x /= cnt;
        p.y /= cnt;
        p.z /= cnt; 

        this.object.surfaces[r].position = p;
    }
    this.slots =[];
    this.name = bdid;
    this.uid = '#-'+generateHexString(16);
    this.mesh = computemesh(this.object);
    this.mesh.isBrick = true;
    return this;
  }
  loadfromFileContent (content) {
    this.object = parsewavefront(content, 'id');
    for (let r = 0; r < this.object.surfaces.length; r++) {
    let cnt = 0;
      let surface = this.object.surfaces[r];
    
        let p = new THREE.Vector3();
        for (let q = 0; q < surface.triangleset.length; q++) {
          let i = surface.triangleset[q];
        
        for (let s = 0; s < 3; s++) {
          let vf = 
         this.object.triangles[surface.triangleset[q]][s];
          p.x +=  this.object.vertices[vf][0];
          p.y +=  this.object.vertices[vf][1];
          p.z +=  this.object.vertices[vf][2];
          cnt++
        }
          
        }
        p.x /= cnt;
        p.y /= cnt;
        p.z /= cnt; 

        this.object.surfaces[r].position = p;
    }
    this.slots =[];
    this.name = this.object.name;
    this.uid = '#-'+generateHexString(16);
    this.mesh = computemesh(this.object);
    this.mesh.isBrick = true;
    return this;
  }
  createslot (type, surfaces, mat) {
   
   let params = {
     type: type,
     mat: mat,
     bmat: this.mesh.matrix,
     brickuid: this.uid,
     xrepeat: 0,
     yrepeat: 0,
     xrepeatinc: 100,
     yrepeatinc: 100,
     surfaces: surfaces,
     index: this.slots.length
   }
    this.slots.push(new Slot(params));
    /*this.slots.push({
      type: type,
      surfaces: surfaces,
      mat: new THREE.Matrix4().fromArray(mat.elements),
      index: this.slots.length
    })*/
  }
  highlight() {
    this.mesh.material[0].color.set(this.color);
  }
  restorecolor() {
    this.mesh.material[0].color.set(this.color);
   // this.mesh.children[0].visible = false;
  }
  updateslotsmatrix () {
    for (let i = 0 ; i < this.slots.length ; i++)
      this.slots[i].updatefmat()
  }
}
class Blender {
  constructor(unit) {
    this.unit = unit;
  }
  addlisteners () {
    this.unit.removeAllListeners();
    this.unit.on('tap', (e) => {
      this.ontap(e);
    });
    this.unit.on('tracestart', (e) => {
      this.ontracestart(e);
    });
    this.unit.on('trace', (e) => {
      this.ontrace(e);
    });
    this.unit.on('traceend', (e) => {
      this.ontraceend(e);
    });
  }
  setcontext () {
    this.addlisteners ();
   // this.addslotactioner();
  }
  removecontext () {
    this.unit.removeAllListeners();
  }
}
class Builder {
  constructor(unit) {
    this.actioners = [];
    this.contextName = 'builder';
    this.unit = unit;
    this.index = this.unit.contexts.length;
    this.gost = {};
    this.addlisteners ()
  }
  addlisteners () {
    this.unit.removeAllListeners();
    this.unit.on('tap', (e) => {
      this.ontap(e);
    });
    this.unit.on('tracestart', (e) => {
      this.ontracestart(e);
    });
    this.unit.on('trace', (e) => {
      this.ontrace(e);
    });
    this.unit.on('traceend', (e) => {
      this.ontraceend(e);
    });
  }
  setcontextmenu () {
    
    if (this.selectedStuffs && this.selectedStuffs.brick )
    window.app.appheadtop.innerHTML = '<i class="icon-cubes"><i/> Assembleur ('+this.unit.bricks.length+') • '+this.selectedStuffs.brick.name+'<i class="icon-floppy-b"><i/><i class="icon-folder-open-empty"><i/>';
    let addbtn = createDiv('+');
    addbtn.addEventListener('click', function () {
      window.app.addunit();
      
    }.bind(this), false);
    window.app.appheadtop.appendChild(addbtn);
    
  }
  setcontext () {
    this.setcontextmenu();
    this.addlisteners ();
   // this.addslotactioner();
  }
  removecontext () {
    this.unit.removeAllListeners();
  }
  ontap (event) {
    
    this.unit.render();

   if (app.tapedStuffs.actioner)
   {
     this.activateactioner(app.tapedStuffs.actioner);
     if (false) {

     let actioner = app.tapedStuffs.actioner;
     let involved = this.getinvolvedbricks(actioner.brick, actioner.slot);
     for (let i = 0; i < involved.length; i++) 
      involved[i].mesh.material[0].color.set('#0072c6')
    this.unit.render();
    
     let rmat = new THREE.Matrix4().makeRotationY(Math.PI/8);
     let amat = new THREE.Matrix4().copy(actioner.matrix).invert();
     let bmat = new THREE.Matrix4().copy(actioner.matrix);
     let fmat = new THREE.Matrix4().multiplyMatrices(rmat, amat);
     fmat.multiplyMatrices(bmat, fmat);
     
     actioner.rbtn = createDiv( 'rotate', 'rotate-btn', '', '', 'click', function () {
     for (let i = 0 ; i < involved.length ; i++)
      involved[i].mesh.matrix.multiplyMatrices(fmat, involved[i].mesh.matrix );
   //   this.unit.centerBuild();
      this.unit.render();
     }.bind(this));
     this.unit.elem.appendChild(actioner.rbtn);
     }
   } else
  /* if (app.tapedStuffs.slot)
   {
     app.tapedStuffs.from.razsurfacehighlightning (app.tapedStuffs.mesh);
     app.tapedStuffs.from.highlightsurface (app.tapedStuffs.slot.surfaces, app.tapedStuffs.mesh)
     app.tapedStuffs.from.render();
     this.selectedStuffs = app.tapedStuffs;
   } else*/
   if (app.tapedStuffs.brick)
   {
     this.unit.restorebrickscolor();
     
     console.log(app.tapedStuffs.brick);
     this.removeslotactioners();
     let busyslots = [];
     
     
     for (let i = 0; i < app.tapedStuffs.brick.slots.length ; i++ ) {
        let slot = app.tapedStuffs.brick.slots[i];
        let brick = app.tapedStuffs.brick;
        let clippedstuffs = this.getclippedstuffs(brick, slot);
        if (clippedstuffs != null)
        {
          busyslots.push({
            busy: { brick:brick,
                    slot:slot    },
            stuffs: clippedstuffs
          });
          
          this.addslotactioner(brick,slot);
          this.unit.render();
        }
        
    }

     this.selectedStuffs = app.tapedStuffs;
     this.unit.statebar.innerHTML = this.contextName+'('+this.unit.bricks.length+') - '+this.selectedStuffs.brick.name+' - '+this.selectedStuffs.brick.color;
 //    this.getbusyslots();
     this.unit.selectedbrick = this.selectedStuffs.brick;
     this.unit.selectedbrick.mesh.children[0].visible = true;
     this.unit.render();
     
  
   }
   else
   {
     this.removeslotactioners();
      if ( this.selectedStuffs) {
      app.tapedStuffs.from.razsurfacehighlightning (this.selectedStuffs.mesh);
       this.selectedStuffs = null;
       app.tapedStuffs.from.render();
      }
   }
   this.setcontextmenu();
  }
  getbusyslots (brick) {
    
    for (let i = 0; i < brick.slots.length; i++) {
      if (brick.slots[i])
    {
      
      let ct = this.selectedStuffs.brick.slots[i].clippedto.brick;
      let bct = this.selectedStuffs.brick.name;

    }
    }
  }
  ontracestart (event) {
    
  this.unit.removecrosscursors();
   if (false) {
   //if (app.draggedStuffs.slot) {
     app.draggedStuffs.from.highlightsurface (app.draggedStuffs.slot.surfaces, app.draggedStuffs.mesh);
     for (let i = 0; i < app.draggedStuffs.slots.length; i++) {
       this.unit.addcrosscursor(app.draggedStuffs.slots[i].position, app.draggedStuffs.slots[i], i*2);
     }
   }
   app.allunits.render(app.draggedStuffs.slot);
  }
  ontraceend (event) {
    

   this.unit.removecrosscursors();
   app.allunits.render();
   if (app.draggedStuffs.slot)
   if (this.gost != undefined)
   {
     app.hoveredStuffs.from.buildarea.remove(this.gost);
     app.draggedStuffs.from.razsurfacehighlightning (app.draggedStuffs.mesh);
    if (app.draggedStuffs.slot && app.dropOnStuffs.slot && (app.hoveredStuffs.brick.uid != app.draggedStuffs.brick.uid))
        this.clip();
   app.allunits.render();
   }
   
  }
  ontrace (event) {
    if (app.draggedStuffs)
    if (app.draggedStuffs.slot)
    { 
      if (app.hoveredStuffs.slot && (app.hoveredStuffs.brick.uid != app.draggedStuffs.brick.uid))
        this.gostclip()
    }
    else
      app.draggedStuffs.from.camcontrols.onPan(event);
  }
  gostclip () {
            // mémorisation de la matrice de transformation de repère du slot ciblé
    let stuffs = app.hoveredStuffs;

    let tgtmat = new THREE.Matrix4().fromArray(stuffs.slot.mat.elements);
        tgtmat.multiplyMatrices(stuffs.brick.mesh.matrix, tgtmat);
                // ajout de la brique vers la Seine cible. 
   for (let i = 0; i < app.draggedStuffs.slots.length; i++) {
                
                
   let areclipable = this.clipable(app.draggedStuffs.slots[i], app.hoveredStuffs.slot);
    if (areclipable != null)
        {
          if (this.gost != undefined)
          app.hoveredStuffs.from.buildarea.remove(this.gost);
          var clone = app.draggedStuffs.brick.mesh.clone();
          
          
          let m = new THREE.Matrix4().fromArray(app.draggedStuffs.slots[i].mat.elements);
          m.invert();
          
          clone.matrixAutoUpdate = false;
          clone.matrix.multiplyMatrices(tgtmat, m);

          for (let i = 0; i < clone.geometry.groups.length; i++) {
            clone.geometry.groups[i].materialIndex = 2;
          }
          

          app.hoveredStuffs.from.buildarea.add(clone);
          app.hoveredStuffs.from.render();
          this.gost = clone;

        }
        if (areclipable != null) break
   }
        
  }
  clip () {
  // mémorisation des scènes émettrice et receveuse de la brique 
    const giver = app.draggedStuffs.from.buildarea;
    const receiver = app.dropOnStuffs.from.buildarea;

    let stuffs = app.dropOnStuffs;
    
    // mémorisation de la matrice de transformation de repère du slot ciblé
    let tgtmat = new THREE.Matrix4().fromArray(stuffs.slot.mat.elements);
    tgtmat.multiplyMatrices(stuffs.brick.mesh.matrix, tgtmat);
   // ajout de la brique vers la Seine cible. 
   
   for (let i = 0; i < app.draggedStuffs.slots.length; i++) {
                
                
     let areclipable = this.clipable(app.draggedStuffs.slots[i], app.hoveredStuffs.slot);
     
   //   let areclipable = this.clipable(app.draggedStuffs.slot, app.dropOnStuffs.slot);
      if (areclipable != null) //TODO vérifier si la brique est la dernière de sa scène donneuse. dans ce cas elle sera cloné sinon elle sera déplacée
      {
        
        let clonedBrick = new Brick().loadfromJson(app.draggedStuffs.brick);
        app.dropOnStuffs.from.bricks.push(clonedBrick);
        clonedBrick.mesh.matrixAutoUpdate = false;
        let m = new THREE.Matrix4().fromArray(app.draggedStuffs.slots[i].mat.elements);
        m.invert();
        clonedBrick.mesh.matrix.multiplyMatrices(tgtmat, m);
        receiver.add(clonedBrick.mesh);
        clonedBrick.updateslotsmatrix();
        if (receiver.uuid == giver.uuid)
        {
          giver.remove(app.draggedStuffs.brick.mesh);
          app.draggedStuffs.from.removeBrick(app.draggedStuffs.brick);
        }
        this.activateactioner(this.addslotactioner (clonedBrick, clonedBrick.slots[app.draggedStuffs.slots[i].index]));
        this.unit.statebar.innerHTML = this.contextName+'('+this.unit.bricks.length+')';
       // this.unit.centerBuild();
      }
      if (areclipable != null) break;
      
    }
  }
  getclippedstuffs(brick, slot) {
    let matrix = brick.mesh.matrix;
    slot.mat = new THREE.Matrix4().fromArray(slot.mat.elements);
    let position = new THREE.Vector3().setFromMatrixPosition(slot.mat).applyMatrix4(matrix);
    for (let bricktocheck of this.unit.bricks) {
      for (let slottocheck of bricktocheck.slots) {

        let matrix1 = bricktocheck.mesh.matrix;
        slottocheck.mat = new THREE.Matrix4().fromArray(slottocheck.mat.elements);;
        let position1 = new THREE.Vector3().setFromMatrixPosition(slottocheck.mat).applyMatrix4(matrix1);

        if (brick.uid != bricktocheck.uid) 
        if (this.clipable(slottocheck, slot))
        if (position1.distanceTo(position) < 1) 
          return {brick:bricktocheck,slot:slottocheck};
      }
    }
    return null ;
  }
  getclippedbricks(brick) {
    let clippedbricks = [];
    for (let bricktocheck of this.unit.bricks) {
      if (this.checkClipping(bricktocheck, brick) == true)
      clippedbricks.push(bricktocheck);
      
    }
    return clippedbricks;
  }
  getclippedbricksexcludecolinear(brick, colinearslotexclusion) {
    let clippedbricks = [];
    for (let bricktocheck of this.unit.bricks) {
  //    if (this.checkClipping(bricktocheck, brick) == true)
      if (this.checkClippingexcludecolinear(bricktocheck, brick,  colinearslotexclusion) == true)
      clippedbricks.push(bricktocheck);
      
    }
    return clippedbricks;
  }
  checkClippingexcludecolinear(brick1, brick2, colinearslotexclusion) {
    let matrix1 = brick1.mesh.matrix;
    let matrix2 = brick2.mesh.matrix;
    for (let surface1 of brick1.slots) {
      // Transformer la position du slot de la première brique dans le système de coordonnées global
      surface1.mat = new THREE.Matrix4().fromArray(surface1.mat.elements);

      let position1 = new THREE.Vector3().setFromMatrixPosition(surface1.mat).applyMatrix4(matrix1);
  
      for (let surface2 of brick2.slots) {
        // Transformer la position du slot de la deuxième brique dans le système de coordonnées global

        surface2.mat = new THREE.Matrix4().fromArray(surface2.mat.elements);
;
        let position2 = new THREE.Vector3().setFromMatrixPosition(surface2.mat).applyMatrix4(matrix2);
        


   //   colinearslotexclusion.isColinear(surface1);
        // Vérifier si les deux positions sont identiques avec une marge de tolérance de 1
        if (position1.distanceTo(position2) < 1 && this.clipable(surface1, surface2) && (surface1.isColinear(colinearslotexclusion) == false) ) {
          // Ajouter la propriété clippedto aux briques
          
          return true;
        }
        
      }
    }
   return false;
  }
  checkClipping(brick1, brick2) {
    for (let surface1 of brick1.slots) {
      // Transformer la position du slot de la première brique dans le système de coordonnées global
      let matrix1 = brick1.mesh.matrix;
      surface1.mat = new THREE.Matrix4().fromArray(surface1.mat.elements);

      let position1 = new THREE.Vector3().setFromMatrixPosition(surface1.mat).applyMatrix4(matrix1);
  
      for (let surface2 of brick2.slots) {
        // Transformer la position du slot de la deuxième brique dans le système de coordonnées global

        let matrix2 = brick2.mesh.matrix;
        surface2.mat = new THREE.Matrix4().fromArray(surface2.mat.elements);

        let position2 = new THREE.Vector3().setFromMatrixPosition(surface2.mat).applyMatrix4(matrix2);

        // Vérifier si les deux positions sont identiques avec une marge de tolérance de 1
        if (position1.distanceTo(position2) < 1 && this.clipable(surface1, surface2)) {
          // Ajouter la propriété clippedto aux briques
          surface1.clippedto = { brick: brick2, slot: surface2 };
          surface2.clippedto = { brick: brick1, slot: surface1 };
          return true;
        }
        
      }
    }
   return false;
  }
  clipable(slot1, slot2) {
    const compatibilities = [  
     {  
       types: [ 'hinge slot b+'],  
       compat: ['hinge slot b-'],
        freedom: [
          { type: 'rotate',
            axis: new THREE.Vector3(0, 1, 0),
            ranges: [{ from: 0, to: 45 },
                     { from: 45, to: 90 },
                     { from: 90, to: 135 },
                     { from: 135, to: 180 },
                     { from: 180, to: 225 },
                     { from: 225, to: 270 },
                     { from: 270, to: 315 },
                     { from: 315, to: 360 }] }
        ]
      },
     {  
       types: [ 'hinge slot b-'],  
       compat: ['hinge slot b+'],
        freedom: [
          { type: 'rotate',
            axis: new THREE.Vector3(0, 1, 0),
            ranges: [{ from: 0, to: 45 },
                     { from: 45, to: 90 },
                     { from: 90, to: 135 },
                     { from: 135, to: 180 },
                     { from: 180, to: 225 },
                     { from: 225, to: 270 },
                     { from: 270, to: 315 },
                     { from: 315, to: 360 }] }
        ]
      },
     {  
       types: [ 'hinge slot a+'],  
       compat: ['hinge slot a-'],
        freedom: [
          { type: 'rotate',
            axis: new THREE.Vector3(0, 1, 0),
            ranges: [{ from: 0, to: 45 },
                     { from: 45, to: 90 },
                     { from: 90, to: 135 },
                     { from: 135, to: 180 },
                     { from: 180, to: 225 },
                     { from: 225, to: 270 },
                     { from: 270, to: 315 },
                     { from: 315, to: 360 }] }
        ]
      },
     {  
       types: [ 'hinge slot a-'],  
       compat: ['hinge slot a+'],
        freedom: [
          { type: 'rotate',
            axis: new THREE.Vector3(0, 1, 0),
            ranges: [{ from: 0, to: 45 },
                     { from: 45, to: 90 },
                     { from: 90, to: 135 },
                     { from: 135, to: 180 },
                     { from: 180, to: 225 },
                     { from: 225, to: 270 },
                     { from: 270, to: 315 },
                     { from: 315, to: 360 }] }
        ]
      },
     {  
       types: [ 'system plate hole', 'brick hole', 'system brick hole', 'technics brick hole', 'technics hole'],  
       compat: ['brick pin', 'system plate pin', 'technics brick pin', 'system brick pin'],
        freedom: [
          { type: 'rotate',
            axis: new THREE.Vector3(0, 1, 0),
            ranges: [{ from: 0, to: 45 },
                     { from: 45, to: 90 },
                     { from: 90, to: 135 },
                     { from: 135, to: 180 },
                     { from: 180, to: 225 },
                     { from: 225, to: 270 },
                     { from: 270, to: 315 },
                     { from: 315, to: 360 }] }
        ]
      },
      {
       types: ['brick pin', 'system plate pin', 'technics brick pin', 'system brick pin'],
       compat: [ 'system plate hole', 'brick hole', 'system brick hole', 'technics brick hole', 'technics hole'],  
        freedom: [
          { type: 'rotate',
            axis: new THREE.Vector3(0, 1, 0),
            ranges: [{ from: 0, to: 45 },
                     { from: 45, to: 90 },
                     { from: 90, to: 135 },
                     { from: 135, to: 180 },
                     { from: 180, to: 225 },
                     { from: 225, to: 270 },
                     { from: 270, to: 315 },
                     { from: 315, to: 360 }] }
        ]
      },
      {
       types: [ 'system plate mid hole', 'brick mid hole', 'system brick mid hole', 'technics brick mid hole', 'technics mid hole'],  
       compat: ['technics brick pin'],
        freedom: [
          { type: 'rotate',
            axis: new THREE.Vector3(0, 1, 0),
            ranges: [{ from: 0, to: 45 },
                     { from: 45, to: 90 },
                     { from: 90, to: 135 },
                     { from: 135, to: 180 },
                     { from: 180, to: 225 },
                     { from: 225, to: 270 },
                     { from: 270, to: 315 },
                     { from: 315, to: 360 }] }
        ]
      },
      {
       types: ['technics brick pin'],
       compat: [ 'system plate mid hole', 'brick mid hole', 'system brick mid hole', 'technics brick mid hole', 'technics mid hole'],  
        freedom: [
          { type: 'rotate',
            axis: new THREE.Vector3(0, 1, 0),
            ranges: [{ from: 0, to: 45 },
                     { from: 45, to: 90 },
                     { from: 90, to: 135 },
                     { from: 135, to: 180 },
                     { from: 180, to: 225 },
                     { from: 225, to: 270 },
                     { from: 270, to: 315 },
                     { from: 315, to: 360 }] }
        ]
      },
      {
       types: ['technics pin'],
       compat: [ 'technics hole'],  
        freedom: [
          { type: 'rotate',
            axis: new THREE.Vector3(0, 1, 0),
            ranges: [{ from: 0, to: 45 },
                     { from: 45, to: 90 },
                     { from: 90, to: 135 },
                     { from: 135, to: 180 },
                     { from: 180, to: 225 },
                     { from: 225, to: 270 },
                     { from: 270, to: 315 },
                     { from: 315, to: 360 }] }
        ]
      },
      {
       types: [ 'technics hole'],  
       compat: ['technics pin'],
        freedom: [
          { type: 'rotate',
            axis: new THREE.Vector3(0, 1, 0),
            ranges: [{ from: 0, to: 45 },
                     { from: 45, to: 90 },
                     { from: 90, to: 135 },
                     { from: 135, to: 180 },
                     { from: 180, to: 225 },
                     { from: 225, to: 270 },
                     { from: 270, to: 315 },
                     { from: 315, to: 360 }] }
        ]
      }
  
      // Ajouter d'autres compatibilités ici
    ];

    const slot1Type = slot1.type;
    const slot2Type = slot2.type;
    for (let i = 0; i < compatibilities.length; i++) {
      if ( compatibilities[i].types.indexOf( slot1Type) != -1 )
      {
        if (compatibilities[i].compat.indexOf(slot2Type) != -1 ) {
      //    this.unit.statebar.appendChild(createSlider(compatibilities[i].freedom[0].ranges));
          return compatibilities[i].freedom;
        }
      }
    }
    return null;
  }
  
  removeslotactioners () {
    for (let i = 0; i < this.actioners.length; i++) {
      this.unit.buildarea.remove(this.actioners[i]);
      if (this.actioners[i].rbtn)
        this.actioners[i].rbtn.remove();
      
      
    }
  }
  addslotactioner (brick, slot) {
        // create a mesh to display cursor
    const geometry = new THREE.CylinderGeometry( 90, 90, 30, 64 );
    let cubeMaterial = new THREE.MeshPhongMaterial(
      {color: 0x0072c6,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
// Ajoute le cube à la scène existante
    let slotActioner = new THREE.Mesh(geometry, cubeMaterial);

  //  this.cursor.renderOrder = 999;
    slotActioner.matrixAutoUpdate = false;
    slotActioner.isHandler = true;
    slotActioner.isActionner = true;
    slotActioner.brick = brick;
    slotActioner.slot = slot;
    
    if (slot) {
      let matrix = brick.mesh.matrix;
      slot.mat = new THREE.Matrix4().fromArray(slot.mat.elements);
      let fmat = new THREE.Matrix4().multiplyMatrices(matrix, slot.mat);
      slotActioner.matrix.copy(fmat)
    }
    this.unit.buildarea.add(slotActioner);
    this.actioners.push(slotActioner);
    return slotActioner;
  }  
  activateactioner (actioner)
  {

     this.removeslotactioners();
     
     this.addslotactioner(actioner.brick, actioner.slot).material.opacity = 0.750;
     let involved = this.getinvolvedbricks(actioner.brick, actioner.slot);
    // for (let i = 0; i < involved.length; i++) 
//      involved[i].mesh.material[0].color.set('#0072c6')
    this.unit.render();
    
     let rmat = new THREE.Matrix4().makeRotationY(Math.PI/8);
     let amat = new THREE.Matrix4().copy(actioner.matrix).invert();
     let bmat = new THREE.Matrix4().copy(actioner.matrix);
     let fmat = new THREE.Matrix4().multiplyMatrices(rmat, amat);
     fmat.multiplyMatrices(bmat, fmat);
     
     actioner.rbtn = createDiv( 'rotate', 'rotate-btn', '', '', 'click', function () {
    for (let i = 0 ; i < involved.length ; i++)
      involved[i].mesh.matrix.multiplyMatrices(fmat, involved[i].mesh.matrix );
   //   this.unit.centerBuild();
      this.unit.updatebricksslotsmatrix();
      this.unit.render();
     }.bind(this));
     this.unit.elem.appendChild(actioner.rbtn);
     
   }
  getinvolvedbricks(brick, slot)  {
    let thisUid = brick.uid;
    let involvedBrickSet = [];
    let referenceBrickSet = [];
    function addInvolvedBrick (bk) {
      let exist = false;
      for (let i = 0; i < involvedBrickSet.length; i++) {
        if (bk.uid == involvedBrickSet[i].uid) exist = true;
      }
      if (exist == false) involvedBrickSet.push(bk)
    }
    function isInvolvedBrick (bk) {
      let exist = false;
      for (let i = 0; i < involvedBrickSet.length; i++) {
        if (bk.uid == involvedBrickSet[i].uid) return true;
      }
      return false
    }
    function addrefbk (bk) {
      let exist = false;
      for (let i = 0; i < referenceBrickSet.length; i++) {
        if (bk.uid == referenceBrickSet[i].uid) exist = true;
      }
      if (exist == false) referenceBrickSet.push(bk)
    }
    function isrefbk (bk) {
      let exist = false;
      for (let i = 0; i < referenceBrickSet.length; i++) {
        if (bk.uid == referenceBrickSet[i].uid) return true;
      }
      return false;
    }
    
    let colinearslotexclusion = slot;
    /*/ build reference brick set
    // add seed
    addrefbk(this.getclippedstuffs(brick, slot).brick);
    // grow référence brick sets
    for (let j = 0; j < referenceBrickSet.length; j++) {
      for (let i = 0; i < referenceBrickSet[j].slots.length; i++)
      {
        console.log('brick '+referenceBrickSet[j].name+'slot '+i+' :');
        let colinear = slot.isColinear(referenceBrickSet[j].slots[i]);
        console.log(colinear);
        if (colinear) console.log('colineairez');
        else {
          if (this.getclippedstuffs(referenceBrickSet[j], referenceBrickSet[j].slots[i])){
          let b = this.getclippedstuffs(referenceBrickSet[j], referenceBrickSet[j].slots[i]).brick;
          if (b)
          addrefbk(b);
          }
        }
      }
    }
    console.log(referenceBrickSet);
    */
    addInvolvedBrick(brick);
    for (let j = 0; j < involvedBrickSet.length; j++) {;
      for (let i = 0; i < involvedBrickSet[j].slots.length; i++)
      {
        console.log('brick '+involvedBrickSet[j].name+'slot '+i+' :');
        let colinear = slot.isColinear(involvedBrickSet[j].slots[i]);
        console.log(colinear);
        if (colinear) console.log('colineairez');
        else {
          if (this.getclippedstuffs(involvedBrickSet[j], involvedBrickSet[j].slots[i])){
          let b = this.getclippedstuffs(involvedBrickSet[j], involvedBrickSet[j].slots[i]).brick;
          if (b)
          addInvolvedBrick(b);
          }
        }
      }
    }
    console.log(involvedBrickSet);

    for (let i = 0; i < this.unit.bricks.length; i++)
    {
      if (!isInvolvedBrick(this.unit.bricks[i]))
        addrefbk(this.unit.bricks[i])
    }
    // highlight sets
    for (let i = 0; i < referenceBrickSet.length; i++)
      referenceBrickSet[i].mesh.material[0].color.set('#700')
    for (let i = 0; i < involvedBrickSet.length; i++)
      involvedBrickSet[i].mesh.material[0].color.set('#070')
    
    this.unit.render();
    return involvedBrickSet;
  }
}
class Caster {
  constructor(unit) {
    this.unit = unit;
    this.index = this.unit.contexts.length;
    this.ui = createDiv('', 'forge');
    this.unit.elem.appendChild(this.ui);
    this.contextName = 'caster';
    this.addlisteners ()
  }
  addlisteners () {
    this.unit.removeAllListeners();
    this.unit.on('tap', (e) => {
      this.ontap(e);
    });
    this.unit.on('trace', (e) => {
      this.ontrace(e);
    });
    this.unit.on('traceend', (e) => {
      this.ontraceend(e);
    });
  }
  setcontextmenu () {
    let metaThemeColor = document.querySelector("meta[name=theme-color]");
    metaThemeColor.setAttribute("content", "#000");
    window.app.appheadtop.innerHTML = '<i class="icon-edit"><i/> Forge <i class="icon-floppy-b"><i/> enregister (brick) <i class="icon-folder-open-empty"><i/> importer';
  }
  setcontext () {
   // this.unit.
   this.setcontextmenu();
   
    window.app.appheadcontent.appendChild(this.ui);
    this.unit.elem.parentNode.prepend(this.unit.elem);
    
    this.ui.classList.toggle('casting');
    let w = this.unit.renderer.domElement.parentNode.parentNode.clientWidth*1;
    let h = this.unit.renderer.domElement.parentNode.parentNode.clientHeight*0.55;
    this.unit.renderer.setSize( w, h);
    this.unit.camera.aspect = h / w;
      this.unit.renderer.setPixelRatio(window.devicePixelRatio);
      this.unit.camera.updateProjectionMatrix();
      this.unit.magneticSizer();
      app.allunits.render();
    
    
    console.log('set caster context');
    console.log(this);
    console.log(this.unit.elem.parentNode);
    this.slotpanel = createElement('div', '', '');
    this.ui.prepend(this.slotpanel);
        this.brickpanel = createElement('div', '', '');
    this.ui.appendChild(this.brickpanel);
    this.btnbar = createElement('div', '', 'btn-bar');
    this.ui.appendChild(this.btnbar);
  
  // ================∞==========÷==÷=============
  // Création de l'élément <input> de type "file"
  // ================∞==========÷==÷=============
    let brickfromfile = createDiv('load brick','file-btn');
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = 'none';
    function handleFileSelect(event) {
      const files = event.target.files;
      const reader = new FileReader();
      // Fonction appelée lorsque le fichier est chargé
      reader.onload = function(e) {
        const brickData = e.target.result;
        this.unit.bank.bricktounit (JSON.parse(brickData), this.unit);
      }.bind(this)
      reader.readAsText(files[0]);
    }
    input.addEventListener("change", handleFileSelect.bind(this), false);
    brickfromfile.addEventListener("click", function () {input.click()}.bind(this), false);
    brickfromfile.appendChild(input);
    this.btnbar.appendChild(brickfromfile);
    
  // ================∞==========÷==÷=============
  // Création de l'élément <input> de type "file"
  // ================∞==========÷==÷=============
    let meshfromfile = createDiv('load mesh','file-btn');
    const meshinput = document.createElement("input");
    meshinput.type = "file";
    meshinput.style.display = 'none';
    function handleFileSelect2(event) {
      const files = event.target.files;
      const reader = new FileReader();
      // Fonction appelée lorsque le fichier est chargé
      reader.onload = function(e) {
        const meshData = e.target.result;
        this.unit.bank.loadmesh(meshData, this.unit)
      }.bind(this)
      reader.readAsText(files[0]);
    }
    meshinput.addEventListener("change", handleFileSelect2.bind(this), false);
    meshfromfile.addEventListener("click", function () {meshinput.click()}.bind(this), false);
    meshfromfile.appendChild(meshinput);
    this.btnbar.appendChild(meshfromfile);
    
    
  
    this.jsonexportbtn = createElement('div', 'save brick', 'file-btn', '','', 'click', function () {
       let nudebrick = {
         object: this.unit.bricks[0].object,
         slots: this.unit.bricks[0].slots,
       }

    // Création d'un objet de type "blob" représentant les données du maillage
     const blob = new Blob([JSON.stringify(this.unit.bricks[0].exportToJson())], { type: "application/json" });
      // Création d'une URL permettant de télécharger le blob sous forme de fichier
      const url = URL.createObjectURL(blob);
      // Création d'un élément <a> pour déclencher le téléchargement du fichier
      const link = document.createElement("a");
      link.href = url;
      link.download = this.unit.bricks[0].name+'.json';
      // Ajout de l'élément <a> au DOM et déclenchement du téléchargement
      document.body.appendChild(link);
      link.click();
      // Nettoyage de l'URL créée
      URL.revokeObjectURL(url);
    }.bind(this));
    this.btnbar.appendChild(this.jsonexportbtn);

    if (this.slotHandler)
      this.slotHandler.visible = true;
    this.addlisteners ();
    this.addslothandler ();
  }
  removecontext () {
    this.unit.removeAllListeners();
    this.ui.innerHTML = '';
    this.ui.classList.toggle('casting');
 
    if (this.slotHandler)
     this.slotHandler.visible = false;
  }
  ontap (event) {
    
   console.log(app.tapedStuffs);
   if (app.tapedStuffs != undefined)
   {

     app.tapedStuffs.from.render();
     if (this.selectedStuffs)
     app.tapedStuffs.slot = this.selectedStuffs.slot;
     this.selectedStuffs = app.tapedStuffs;
     
     this.slotexplorer();
   }
    else
    {
      if ( this.selectedStuffs) { 
   //   app.tapedStuffs.from.cristalsurfacehighlightning (this.selectedStuffs.mesh);
       //this.selectedStuffs = null;
       app.tapedStuffs.from.render();
      }
    }
  }
  ontrace (event) {
    app.draggedStuffs.from.camcontrols.onPan(event)
  }
  
  ontraceend (event) {
    app.draggedStuffs.from.camcontrols.onPanEnd(event)
  }
  slotexplorer () {
    this.slotpanel.innerHTML= '';
    if (this.selectedStuffs)
    if (this.selectedStuffs.brick != null)
    {
      
      
      let namesection = createDiv('brick : ', 'brickname-section');
      let nameinput = createElement('input', '', 'brickname', '', '', 'change',function () {
      this.unit.bricks[0].name = nameinput.value;
      
      }.bind(this))
      nameinput.value = this.unit.bricks[0].name;
      namesection.appendChild(nameinput);
      namesection.appendChild(createElement('div', this.selectedStuffs.brick.uid, 'uid' ));
      this.slotpanel.appendChild(namesection);
      
      this.slotpanel.appendChild(createElement('div', ' brick.object :'));
      this.slotpanel.appendChild(createElement('div', this.selectedStuffs.brick.object.surfaces.length +' surfaces'));
      this.slotpanel.appendChild(createElement('div', this.selectedStuffs.brick.object.frontiers.length +' frontieres de surfaces'));

      this.slotpanel.appendChild(createElement('div', this.selectedStuffs.brick.slots.length +' slot(s)'));
      
      
      let slotlist = createDiv('','slotlist');
      this.slotpanel.appendChild(slotlist);
    for (let i = 0; i < this.selectedStuffs.brick.slots.length; i++) {
      
    if ( this.selectedStuffs.slot ) {
      if ( i == this.selectedStuffs.slot.index ) {
      slotlist.prepend(this.slotoptions(this.selectedStuffs.brick.slots[i])); 
      }
    else {
      slotlist.appendChild(this.slotitemoptions(this.selectedStuffs.brick.slots[i]));
    }
    }
    else {
      slotlist.appendChild(this.slotitemoptions(this.selectedStuffs.brick.slots[i]));
    }
    }
    let slotadderbtnb = createElement('div', 'add slot', 'btn', '','', 'click', function () {
      this.selectedStuffs.brick.createslot(1,[...this.unit.surfaceselection], new THREE.Matrix4().identity());
      this.slotexplorer();
    }.bind(this));
    slotlist.appendChild(slotadderbtnb);
    }
  }
  slotoptions (slot)  {
    
    let s = createDiv('slot '+slot.index+' ', 'slot-edit-block');
    let typeSelect = document.createElement('select');
    s.appendChild(typeSelect);
    
    var m = new THREE.Matrix4().fromArray(slot.mat.elements);
    var c = new THREE.Vector3(0,0,0);
    // ////console .log(c);
    c.setFromMatrixPosition(m);
    let posxyz = createMatrixPositionInputs (slot.mat, this.slotHandler, 'position: ');
    s.appendChild(posxyz);
    let axemid = createMatrixRotationButtons(slot.mat, this.slotHandler);
    s.appendChild(axemid);
    let surfaces = createDiv('surfaces : '+ slot.surfaces);
    s.appendChild(surfaces);
    let syncsurf = createElement('button', 'sync with selection', '', '', '', 'click',function () {
      slot.surfaces = [...getGroupIndices(this.unit.bricks[0].mesh, 1)];
  
      this.slotexplorer();
    }.bind(this));
    s.appendChild(syncsurf);
   
    
    typeSelect.addEventListener('change', function() {
      slot.type = typeSelect.value;
      this.slotexplorer();
    }.bind(this));
  
  // Créer les options de sélection pour les différents types de slot
  let types = [
    'system plate hole',
    'brick hole',
    'system brick hole',
    'technics brick hole',
    'technics hole', 
    'technics pin', 
    'brick pin',
    'system plate pin',
    'technics brick pin',
    'system brick pin',
    'brick mid hole',
    'system plate mid hole',
    'system brick mid hole',
    'technics brick mid hole',
    'hinge slot a+',
    'hinge slot a-',
    'hinge slot b+',
    'hinge slot b-'
    ];
        for (let i = 0; i < types.length; i++) {
          let option = document.createElement('option');
          option.value = types[i];
          option.text = types[i];
          typeSelect.appendChild(option);
        }
        
        // Sélectionner l'option correspondant au type actuel du slot
        typeSelect.value = slot.type;

        return s;
      }
  slotitemoptions (slot)  {
      let s = createDiv('['+slot.index+']\n '+slot.type, 'btn', '', '', 'click', function () {
      this.selectedStuffs.slot = slot;
      this.selectedStuffs.slots = [slot];
      this.unit.slotselection = [slot.index];
      this.selectedSlot = slot;
      
      this.unit.setSurfaceSelectionFromSlotSelection(this.selectedStuffs);
      this.slotHandler.matrix.copy(this.selectedStuffs.slots[0].mat);
      
      
      
      this.unit.render();
      this.slotexplorer();
      this.slotexplorer();
      }.bind(this));
      return s;
    }
  addslothandler () {
        // create a mesh to display cursor
    let cursorO = new THREE.BoxGeometry(30, 60, 30);
    let cursorx = new THREE.BoxGeometry(45, 8, 8);
    let cursory = new THREE.BoxGeometry(15, 45, 15);
    let cursorz = new THREE.BoxGeometry(8, 8, 45);
    
    let cubeGeometry = new THREE.SphereGeometry(15, 15, 15);
    let cursorOmtl = new THREE.MeshPhongMaterial(
      {color: 0xdd00dd,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
    let cursorXmtl = new THREE.MeshPhongMaterial(
      {color: 0xdd0000,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
    let cursorYmtl = new THREE.MeshPhongMaterial(
      {color: 0x00dd00,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
    let cursorZmtl = new THREE.MeshPhongMaterial(
      {color: 0x0000dd,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
    let cubeMaterial = new THREE.MeshPhongMaterial(
      {color: 0xff6f00,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
// Ajoute le cube à la scène existante
    this.slotHandler = new THREE.Mesh(cubeGeometry, cursorOmtl);
    let xaxis = new THREE.Mesh(cursorx, cursorXmtl);
    xaxis.position.setX(30);
    this.slotHandler.add(xaxis);
    let yaxis = new THREE.Mesh(cursory, cursorYmtl);
    yaxis.position.setY(30);
    this.slotHandler.add(yaxis);
    let zaxis = new THREE.Mesh(cursorz, cursorZmtl);
    zaxis.position.setZ(30);
    this.slotHandler.add(zaxis);
  //  this.cursor.renderOrder = 999;
    this.slotHandler.matrixAutoUpdate = false;
    this.slotHandler.isHandler = true;
  //  this.unit.scene.add(this.slotHandler);
 //   let scalematrix = new THREE.Matrix4().makeScale(2,2,2);
  //  this.slotHandler.matrix.multiplyMatrices(this.slotHandler.matrix, scalematrix);
    this.unit.buildarea.add(this.slotHandler);
  }
}
class Unit {
  constructor(domdest) {

    this.bricks = [];
    this.events = {};
    
    this.elem = createDiv('', 'unit');
    domdest.appendChild(this.elem);
    this.sizerdiv = createDiv('resizing', 'sizer-div');
    this.h = domdest.clientHeight;
    this.w = domdest.clientWidth;
    this.rqx = undefined;
    this.rqy = undefined;
    
    this.statebar = createDiv('', 'state-bar');
    this.zoomhandler = createDiv( '', 'zoom-handler');
    this.elem.appendChild(this.zoomhandler);
    this.bottomrighthandler = createDiv( '', 'bottom-right-handler');
    this.elem.appendChild(this.bottomrighthandler);
    this.toplefthandler = createElement('div', '', 'top-left-handler');
    this.elem.appendChild(this.toplefthandler);
    
    this.surfaceselection = [];
    this.slotselection = [];
    this.brickselection = [];
    this.selectedbrick = null;
    
    

    this.uid = '#unit-'+generateHexString(16);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera( 75, this.w/this.h, 0.1, 10000 );
    this.camera.position.z = 400;
    this.renderer = new THREE.WebGLRenderer({antialias:true, alpha: true});
    this.renderer.setClearColor("#dfdfdf");
    this.renderer.setSize( this.w, this.h );
    this.renderer.shadowMap.enabled = true;
console.log(this);
    this.elem.appendChild( this.renderer.domElement );

    this.addcursor ();

    const light = new THREE.AmbientLight( 0xbbbbbb);
    this.scene.add( light );
    const pointLight = new THREE.PointLight(0xaaaaaa, 0.89);
    pointLight.position.set(100, 800, 700);
    pointLight.castShadow = true;
    pointLight.shadow.mapSize.width = 4096;
    pointLight.shadow.mapSize.height = 4096;
    pointLight.shadow.camera.near = 0.1;
    pointLight.shadow.camera.far = 5000;
    pointLight.shadow.camera.left = -100;
    pointLight.shadow.camera.right = 100;
    pointLight.shadow.camera.top = 100;
    pointLight.shadow.camera.bottom = -100;

    this.scene.add(pointLight);
    let boxx = new THREE.CircleGeometry( 4000, 128 );
    let boxxmtl = new THREE.MeshPhongMaterial(
      {color: 0x999999,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: false,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
    this.outbox = new THREE.Mesh(boxx, boxxmtl);
    this.outbox.castShadow = false;
    this.outbox.receiveShadow = true;
    this.outbox.position.setY(-150);
    this.outbox.rotation.fromArray([Math.PI/2, 0, 0]);
    
    this.scene.add(this.outbox);
    
    this.camcontrols = new orbCamControls(this);
    this.contexts = [];
    this.contexts.push(new Caster(this));
    this.contexts.push(new Builder(this));
    this.context = this.contexts[0];
    this.context.setcontext();
    this.elem.appendChild(this.statebar);
    this.switchcontext();
    this.render();
    this.bottomRightButtonManager();
    this.topLeftButtonManager();
    this.zoomButtonManager();
    this.bank = new Bank(this);
    this.urlbrickbank = createDiv('', 'url-bank');
    this.initUrlBrickBank( this.bank.urlbank);
    
    this.colorbank = createDiv('', 'color-bank');
    this.initColorBank( this.bank.colorbank);
  }
  getApparentHeight(object) {
    // Obtenir les dimensions du renderer
    const rendererSize = this.renderer.getSize(new THREE.Vector2());
    l(rendererSize);
    // Calculer les coordonnées 3D des coins supérieur et inférieur de l'objet
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    l(size);

    const top = new THREE.Vector3(box.max.x, box.max.y, box.max.z);
    const bottom = new THREE.Vector3(box.min.x, box.min.y, box.min.z);

    // Convertir les coordonnées 3D en coordonnées 2D
    const topProjected = top.project(this.camera);
    const bottomProjected = bottom.project(this.camera);

    // Convertir les coordonnées normalisées [-1, 1] en pixels
    const topY = ((1 - topProjected.y) / 2) * rendererSize.y;
    const bottomY = ((1 - bottomProjected.y) / 2) * rendererSize.y;

    // Calculer la hauteur apparente en pixels
    const apparentHeight = Math.abs(bottomY - topY);
    return apparentHeight;
}
  setCameraDistanceForApparentHeight(object, targetHeight) {
    // Obtenir les dimensions du renderer
    const rendererSize = this.renderer.getSize(new THREE.Vector2());

    // Calculer les coordonnées 3D des coins supérieur et inférieur de l'objet
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());

    const top = new THREE.Vector3(box.max.x, box.max.y, box.max.z);
    const bottom = new THREE.Vector3(box.min.x, box.min.y, box.min.z);

    // Convertir les coordonnées 3D en coordonnées 2D pour obtenir la hauteur initiale
    const topProjected = top.project(this.camera);
    const bottomProjected = bottom.project(this.camera);

    // Convertir les coordonnées normalisées [-1, 1] en pixels
    const initialTopY = ((1 - topProjected.y) / 2) * rendererSize.y;
    const initialBottomY = ((1 - bottomProjected.y) / 2) * rendererSize.y;

    // Calculer la hauteur apparente initiale en pixels
    const initialHeight = Math.abs(initialBottomY - initialTopY);

    // Calculer le facteur de mise à l'échelle nécessaire pour atteindre la hauteur cible
    const scale = targetHeight / initialHeight;

    // Calculer la nouvelle position de la caméra sur l'axe z
    const cameraDistance = this.camera.position.z * scale;

    // Mettre à jour la position de la caméra
    this.camera.position.z = cameraDistance;

    return this.camera.position.z;
}
  centerBuild () {
          const scene = this.buildarea;
    const boundingBox = new THREE.Box3().setFromObject(scene);
   const boundingSphere = boundingBox.getBoundingSphere(new THREE.Sphere());
   console.log(boundingSphere);
   let mt = boundingSphere.center;
   let tmat = new THREE.Matrix4().makeTranslation(-mt.x, -mt.y, -mt.z);
   for (let i = 0 ; i < this.bricks.length ; i++)
      this.bricks[i].mesh.matrix.multiplyMatrices(tmat, this.bricks[i].mesh.matrix );
  }
  magneticSizer () {
    
    let nxqmin = 3;
    let nyqmin = 5;
    let nxqmax = 12;
    let nyqmax = 24;
    let chaussepied = 1;
    
    this.xquanta = window.innerWidth/nxqmax;
    this.yquanta = (0.96*window.innerHeight)/nyqmax;
    
    const elementPos = this.renderer.domElement.getBoundingClientRect();
    
    let nXquanta = ((elementPos.width / this.xquanta).toFixed(0));
    let nYquanta = ((elementPos.height / this.yquanta).toFixed(0));
    
    if (nXquanta < nxqmin) nXquanta = nxqmin;
    if (nYquanta < nyqmin) nYquanta = nyqmin;
    if (nXquanta > nxqmin) nXquanta = nxqmax;
    if (nYquanta > nyqmin) nYquanta = nyqmax;

    let magneticwidth = nXquanta*this.xquanta;
    let magneticheight = nYquanta*this.yquanta;
    
    l("mw: "+magneticwidth+", mh: "+ magneticheight);
    l("qx: "+nXquanta+", qy: "+ nYquanta);
    
    
    this.renderer.setSize( magneticwidth, magneticheight );
    this.camera.aspect = magneticwidth / magneticheight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.h = this.renderer.domElement.clientHeight;
    this.w = this.renderer.domElement.clientWidth;
    app.allunits.render();
    let a = this.renderer.domElement.getBoundingClientRect();
    let b = this.elem.getBoundingClientRect();
//   console.log(this);
//   console.log(this.renderer.getSize());
  }
  magneticSizer2 (el) {
    
    let nxqmin = 2;
    let nyqmin = 2;
    let nxqmax = 6;
    let nyqmax = 12;
    let chaussepied = 1;
    
    this.xquanta = window.innerWidth/nxqmax;
    this.yquanta = (0.96*window.innerHeight)/nyqmax;
    
    const elementPos = el.getBoundingClientRect();
    
    let nXquanta = ((elementPos.width / this.xquanta).toFixed(0));
    let nYquanta = ((elementPos.height / this.yquanta).toFixed(0));
   

 
    if (nXquanta < nxqmin) nXquanta = nxqmin;
    if (nYquanta < nyqmin) nYquanta = nyqmin;
    if (nXquanta > nxqmax) nXquanta = nxqmax;
    if (nYquanta > nyqmax) nYquanta = nyqmax;

    let magneticwidth = nXquanta*this.xquanta;
    let magneticheight = nYquanta*this.yquanta;
        el.innerText = 'q: '+nXquanta+'x'+nYquanta+' /n mw: '+magneticwidth+', mh: '+ magneticheight;
    this.rqx = nXquanta;
    this.rqy = nYquanta;
    el.style.height = magneticheight+'px';
    el.style.width =magneticwidth+'px';
    
    
    
  }
  initUrlBrickBank(brickList) {
   
    brickList.forEach((brick) => {
      const li = createDiv('', 'url-stuff');
      li.textContent = brick.name;
      li.addEventListener('click', function ()  {
        getJSON(brick.url, function (data)  {
          console.log(this);
          this.bank.bricktounit(data, this);
          this.urlbrickbank.classList.toggle('visible');
        }.bind(this));
      }.bind(this));
      this.urlbrickbank.appendChild(li);
    });
    this.elem.appendChild(this.urlbrickbank);
  }
  initColorBank(colorList) {
    colorList.forEach((color) => {
      const li = createDiv('', 'color-stuff');
     // li.textContent = color.name;
      li.style.background = color.def;
      li.addEventListener('click', function ()  {
        if (this.selectedbrick) {
          this.selectedbrick.color = color.def;
          console.log(this.selectedbrick);
          this.restorebrickscolor();
          this.render();
          this.colorbank.classList.toggle('visible');
        }
        else
        alert('sélectionnez unebbrique a teinter')
      }.bind(this));
      this.colorbank.appendChild(li);
    });
    this.elem.appendChild(this.colorbank);
  }
  
  topLeftButtonManager () {
    let anhammer = new Hammer ( this.toplefthandler ); 
    anhammer.get('tap').set({ enable: true });
    anhammer.get('doubletap').set({ enable: true });
    anhammer.on('tap', function (e) {
     this.urlbrickbank.classList.toggle('visible')
    }.bind(this));
    anhammer.on('doubletap', function (e) {
     app.saveUnitState(this);
     app.objToJsonFile(app.data.unitstates[app.data.unitstates.length-1], 'build #'+(app.data.unitstates.length));
    }.bind(this));
    anhammer.get('press').set({ enable: true });
    anhammer.on('pressup', function (e) {
      
      app.objFromJsonFile();
    }.bind(this));
  }
  
  colormanager () {
    let anhammer = new Hammer ( this.bottomrighthandler ); 
    anhammer.get('tap').set({ enable: true });
    anhammer.on('tap', function (e) {
     this.colorbank.classList.toggle('visible')
    }.bind(this));
  }
  zoomButtonManager () {
    let anhammer = new Hammer ( this.zoomhandler ); 
    anhammer.get('tap').set({ enable: true });
    anhammer.on('tap', function (e) {
     
    }.bind(this));
    anhammer.get('press').set({ enable: true });
    anhammer.on('pressup', function (e) {
    }.bind(this));
    anhammer.get('pan').set({ enable:true, direction: Hammer.DIRECTION_ALL, preventDefault: true  });
    anhammer.on('panstart', function (e) {
      
    }.bind(this));
    anhammer.on('pan', function (e) {
      let r = {x:e.deltaX, y:e.deltaY};
      console.log(r);
      this.camcontrols.zoom -= r.y*0.0004;
      this.camcontrols.rotation.x = 0;
      this.camcontrols.rotation.y = 0
    this.camcontrols.updateCamera();
      app.allunits.render();
      
    }.bind(this));
    
    anhammer.on('panend', this.magneticSizer.bind(this));
    anhammer.on('pancancel', this.magneticSizer.bind(this));
  }
  bottomRightButtonManager () {
    let anhammer = new Hammer ( this.bottomrighthandler ); 
    anhammer.get('tap').set({ enable: true });
    anhammer.on('tap', function (e) {
     this.colorbank.classList.toggle('visible')
    }.bind(this));
    anhammer.get('press').set({ enable: true });
    anhammer.on('pressup', function (e) {
     this.switchcontext();
   
    }.bind(this));
    anhammer.get('pan').set({ enable:true, direction: Hammer.DIRECTION_ALL, preventDefault: true  });
    anhammer.on('panstart', function (e) {
      this.startsize =  {w: this.elem.clientWidth, h: this.elem.clientHeight};
      
      this.elem.appendChild(this.sizerdiv );
      
    }.bind(this));
    anhammer.on('pan', function (e) {
      let r = {x:e.deltaX, y:e.deltaY};
      
      
      if (r.x*r.x > r.y*r.y)
      {
        this.sizerdiv.style.width = (this.startsize.w + r.x)+'px';
        this.sizerdiv.style.height = (this.startsize.h)+'px';
      }
      else
      {
        this.sizerdiv.style.width = (this.startsize.w)+'px';
        this.sizerdiv.style.height = (this.startsize.h + r.y)+'px';
        
      }
      
      this.magneticSizer2(this.sizerdiv)
      
      /*
      this.renderer.setSize( this.startsize.w+r.x, this.startsize.h+r.y);
      let magneticwidth = this.startsize.w+r.x;
      let magneticheight = this.startsize.h+r.y
      this.camera.aspect = magneticwidth / magneticheight;
    //  this.renderer.setPixelRatio(window.devicePixelRatio);
      this.camera.updateProjectionMatrix();
      this.h = this.renderer.domElement.clientHeight;
      this.w = this.renderer.domElement.clientWidth;
      app.allunits.render();
      this.magneticSizer();*/
    }.bind(this));
    
    anhammer.on('panend', function (e) {
      
  //  this.magneticSizer.bind(this)
  this.setsize();
  this.sizerdiv.remove();
    }.bind(this));
    anhammer.on('pancancel', this.magneticSizer.bind(this));
  }
  on(event, callback) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(callback);
  }
  emit(event, ...args) {
    const eventCallbacks = this.events[event];
    if (eventCallbacks) {
      eventCallbacks.forEach(callback => callback(...args));
    }
  }
  removeAllListeners() {
    this.events = {};
  }
  switchcontext () {
    let contextnumber = ( this.context.index + 1 );
    if (contextnumber >= this.contexts.length)
      contextnumber = 0;
      this.context.removecontext();
    this.context = this.contexts[contextnumber];
    //tiswitchcontext ();
    this.context.setcontext();
    this.statebar.innerHTML = this.context.contextName+'('+this.context.unit.bricks.length+')';
    
  }
  removecrosscursors () {
    for (let i = 0; i < this.buildarea.children.length; i++) 
    if (this.buildarea.children[i].isCrossCursor)
    this.buildarea.remove(this.buildarea.children[i])
  }
  addcrosscursor (position, slot,
  thickness = 0.5) {
    
        // create a mesh to display cursor
    let cursorO = new THREE.SphereGeometry(2, 10,10);
    let cursorx = new THREE.BoxGeometry(125, thickness, thickness);
    let cursory = new THREE.BoxGeometry(thickness*3, 125, thickness*3);
    let cursorz = new THREE.BoxGeometry(thickness, thickness, 125);
    
    let cubeGeometry = new THREE.SphereGeometry(10, 10, 10);
    let cubeMaterial = new THREE.MeshPhongMaterial(
      {color: 0x000000,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
// Ajoute le cube à la scène existante
    let cross = new THREE.Mesh(cursorO, cubeMaterial);
    let xaxis = new THREE.Mesh(cursorx, cubeMaterial);
    xaxis.position.setX(15);
    cross.add(xaxis);
    let yaxis = new THREE.Mesh(cursory, cubeMaterial);
    yaxis.position.setY(15);
    cross.add(yaxis);
    let zaxis = new THREE.Mesh(cursorz, cubeMaterial);
    zaxis.position.setZ(15);
    cross.add(zaxis);
  //  this.cursor.renderOrder = 999;
//console.log(position);
    cross.isCrossCursor = true;
  //  cross.matrixAutoUpdate = true;
 /*   cross.position.setX(position.x);
    cross.position.setY(position.y);
    cross.position.setZ(position.z); */
    cross.matrix.copy(slot.fmat);
    cross.matrixAutoUpdate = false;
    this.buildarea.add(cross);
  //  cross.updateMatrix();
  }
  setsize () {
     
    let magneticwidth = this.rqx*this.xquanta;
    let magneticheight = this.rqy*this.yquanta;
    
    this.renderer.setSize( magneticwidth, magneticheight );
    this.camera.aspect = magneticwidth / magneticheight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.h = this.renderer.domElement.clientHeight;
    this.w = this.renderer.domElement.clientWidth;
    app.allunits.render();
    let a = this.renderer.domElement.getBoundingClientRect();
    let b = this.elem.getBoundingClientRect();
  }
  addcursor () {
        // create a mesh to display cursor
    let cursorO = new THREE.SphereGeometry(3, 10,10);
    let cursorx = new THREE.BoxGeometry(15, 2, 2);
    let cursory = new THREE.BoxGeometry(2, 15, 2);
    let cursorz = new THREE.BoxGeometry(2, 2, 15);
    
    let cubeGeometry = new THREE.SphereGeometry(10, 10, 10);
    let cursorOmtl = new THREE.MeshBasicMaterial(
      {color: 0x444444,
      
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
    let cursorXmtl = new THREE.MeshPhongMaterial(
      {color: 0xdd0000,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
    let cursorYmtl = new THREE.MeshPhongMaterial(
      {color: 0x00dd00,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
    let cursorZmtl = new THREE.MeshPhongMaterial(
      {color: 0x0000dd,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
    let cubeMaterial = new THREE.MeshPhongMaterial(
      {color: 0xff6f00,
      specular: 0xaaaaaa,
      shininess: 0.0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: true,
      flatShading: true});
// Ajoute le cube à la scène existante
    this.buildarea = new THREE.Mesh(cursorO, cursorOmtl);
    let xaxis = new THREE.Mesh(cursorx, cursorXmtl);
    xaxis.position.setX(15);
    this.buildarea.add(xaxis);
    let yaxis = new THREE.Mesh(cursory, cursorYmtl);
    yaxis.position.setY(15);
    this.buildarea.add(yaxis);
    let zaxis = new THREE.Mesh(cursorz, cursorZmtl);
    zaxis.position.setZ(15);
    this.buildarea.add(zaxis);
  //  this.cursor.renderOrder = 999;

    this.buildarea.isHandler = true;
    this.scene.add(this.buildarea);
  }
  addbrick2 (b) {
    this.bricks.push(new Brick().loadfromJson(b));
 //   this.meshs.push(this.bricks[this.bricks.length-1].mesh);
    this.bricks[this.bricks.length-1].mesh.matrixAutoUpdate = false;
    this.buildarea.add(this.bricks[this.bricks.length-1].mesh);
  }
  addpositionedjsonbrick (brick, positionmatrix, color) {
    brick.color = color;
    this.bricks.push(new Brick().loadfromJson(brick));
    this.bricks[this.bricks.length-1].mesh.matrixAutoUpdate = false;
    this.bricks[this.bricks.length-1].mesh.matrix.fromArray(positionmatrix);
    this.buildarea.add(this.bricks[this.bricks.length-1].mesh);

  }
  addvirginbrick (mesh) {
    this.bricks.push(new Brick().loadfromFileContent(mesh));
    //this.meshs.push(this.bricks[this.bricks.length-1].mesh);
  //  this.scene.add(this.bricks[this.bricks.length-1].mesh);
    this.buildarea.add(this.bricks[this.bricks.length-1].mesh);
  }
  brickbtid (uid) {
    true
  }
  cristalsurfacehighlightning (o) {
    for (let i = 0; i < o.geometry.groups.length; i++)
     o.geometry.groups[i].materialIndex = 2;
  }
  razsurfacehighlightning (o) {
  
    for (let i = 0; i < o.geometry.groups.length; i++)
     o.geometry.groups[i].materialIndex = 0;
  }
  setSurfaceSelectionFromSlotSelection (stuffs) {
    for (let i = 0; i < stuffs.mesh.geometry.groups.length; i++) {
     stuffs.mesh.geometry.groups[i].materialIndex = 2;
     for (let j = 0; j < this.slotselection.length; j++) {
       for (let k = 0; k < stuffs.slots[j].surfaces.length; k++) 
       if (stuffs.slots[j].surfaces[k] == i )
       stuffs.mesh.geometry.groups[i].materialIndex = 1;
     }
    }
    stuffs.from.render()
  }
  highlightsurface (surfaces, object) {
    for (let i = 0; i < surfaces.length; i++)
     object.geometry.groups[surfaces[i]].materialIndex = 1;

  }
  togglesurfacelightning (surfaces, object) {
  for (let i = 0; i < surfaces.length; i++)
  if (object.geometry.groups[surfaces[i]].materialIndex != 1 )
  object.geometry.groups[surfaces[i]].materialIndex = 1;
  else
  object.geometry.groups[surfaces[i]].materialIndex = 0;
  }
  moveground(y) {
    this.outbox.position.setY(y);
  }
  movebuild(x,y,z) {
    this.buildarea.position.setX(x);
    this.buildarea.position.setY(y);
    this.buildarea.position.setZ(z);
  }
  showcursor () {
    
  }
  ontap (event) {
    ////console .log(event);
   app.tapedStuffs = this.stuffsAt(this.geteventpos(event));
   this.emit('tap', event);
   
   const scene = this.buildarea;
    const boundingBox = new THREE.Box3().setFromObject(scene);
   const boundingSphere = boundingBox.getBoundingSphere(new THREE.Sphere());
//   this.movebuild(-boundingSphere.center.x, -boundingSphere.center.y, -boundingSphere.center.z);
   this.moveground(-(boundingSphere.radius+70));
  // app.allunits.hidebottomrightcorner();
  }
  geteventpos (event) {
    const elementPos = this.elem.getBoundingClientRect();
    const mouse = new THREE.Vector2();
    mouse.x = ((event.center.x - elementPos.x) / this.w) * 2 - 1;
    mouse.y = -((event.center.y - elementPos.y) / this.h) * 2 + 1;
    return mouse;
  }
  
  onpinchstart(event) {
    this.camcontrols.onPinchStart(event);
  }
  onpinch(event) {
    this.camcontrols.onPinch(event);
  }
  onpinchend(event) {
    this.camcontrols.onPinchEnd(event);
  }
  ontracestart (event) {
    app.draggedStuffs = this.stuffsAt(this.geteventpos(event));
    this.emit('tracestart', event);
  }
  ontrace (event) {
    app.hoveredStuffs = this.stuffsAt(this.geteventpos(event));
    this.emit('trace', event);
  }
  ontraceend (event) {
    app.dropOnStuffs = this.stuffsAt(this.geteventpos(event));
    this.emit('traceend', event);
    
    
  }
  
  getBrickFromUid () {
    for (let i = 0; i < this.bricks.length; i++) {
      if ( this.bricks[i].uid == uid )
      return this.bricks[i].uid;
    }
    alert('no brick with this uid in this unit');
  }
  restorebrickscolor () {
    for (let brick of this.bricks) {
      brick.restorecolor();''
    }
  }
  removeBrick (b) {
    let uid = b.uid;
    for (let i = 0; i < this.bricks.length; i++) {
      if ( this.bricks[i].uid == uid ) {
      this.bricks.splice(i, 1);
        return b;
      }
    }
    alert('no brick with this uid in this unit');
  }
  //  checkout stuff at normalized position
  
  stuffsAt (mouse) {
  // tire d'un rayon et récupération de ses intersections avec les différents maillages de cette scène
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, this.camera);
      const intersects = [];
      this.scene.traverse((child) => {
        if ( child.isBrick || child.isActionner) {
          intersects.push(...raycaster.intersectObject(child));
        }
      });
      function sortintersectsbydistance(tableau) {
          tableau.sort(function(a, b) {
            return a.distance - b.distance;
          });
        }
      sortintersectsbydistance(intersects);
      
      var stuffs = {};
      // traitement des intersections
      if (intersects.length > 0) {
        // récupération de la surface cible
        var faceIndex = intersects[0].faceIndex;
        var object = intersects[0].object;
        if (object.isBrick) {
          
          var targetBrick;
          for (let i = 0; i < this.bricks.length; i++)
            if (this.bricks[i].mesh.uuid == object.uuid)
              targetBrick = this.bricks[i];
          var targetSlot;
          var targetSlotList = [];
          for (let i = 0; i < targetBrick.slots.length; i++) {
        
            let c = new THREE.Vector3().setFromMatrixPosition(targetBrick.slots[i].mat);
            c.applyMatrix4(targetBrick.mesh.matrixWorld);
            let d = intersects[0].point.distanceTo(c);
            targetBrick.slots[i].dist = d;
            targetSlotList.push(targetBrick.slots[i]);
          
          }
          function trierTableauParDist(tableau) {
            tableau.sort(function(a, b) {
              return a.dist - b.dist;
            });
          }
          
          trierTableauParDist(targetSlotList);
       if (targetSlotList.length > 0 ) {
          stuffs.slots = targetSlotList;
          stuffs.slot = targetSlotList[0];
        }
        if (targetBrick) stuffs.brick = targetBrick;
        stuffs.faceIndex = faceIndex;
        stuffs.at = intersects[0].point;
        stuffs.mesh = object;
        
        }
        if (object.isActionner) {
          //console .log('app.tapedStuffs');
          //console .log(app.tapedStuffs);
          stuffs.actioner = object;
          //console .log(object);
         // object.material.color.set('#d00')
  /*        var inputRange = document.createElement("input");
          inputRange.classList.add('custom-slider');
		inputRange.type = "range";
		inputRange.min = "0";
		inputRange.max = "360";
		inputRange.value = "180";
		inputRange.id = "mon-range";

		// Ajouter le nouvel élément input range à la page
		var container = document.getElementById("container");
		this.elem.appendChild(inputRange);*/
		
         // alert('actioners')
        }
    }
    stuffs.from = this;
    return stuffs;
  }
  stuffsAt2 (mouse) {
  // tire d'un rayon et récupération de ses intersections avec les différents maillages de cette scène
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, this.camera);
      const intersects = [];
      this.scene.traverse((child) => {
        if ( child.isBrick || child.isActionner) {
          intersects.push(...raycaster.intersectObject(child));
        }
      });
      function sortintersectsbydistance(tableau) {
          tableau.sort(function(a, b) {
            return a.distance - b.distance;
          });
        }
      sortintersectsbydistance(intersects);
      
      var stuffs = {};
      // traitement des intersections
      if (intersects.length > 0) {
        // récupération de la surface cible
        var faceIndex = intersects[0].faceIndex;
        var object = intersects[0].object;
        if (object.isBrick) {
        let targetSurface = this.getgroupnumberfromfaceindex (object, faceIndex);
        // récupération de la brique cible
        var targetBrick;
        ////console .log(object.uuid);
        for (let i = 0; i < this.bricks.length; i++) {
          ////console .log('-> '+this.bricks[i].mesh.uuid);
          if (this.bricks[i].mesh.uuid == object.uuid) {
            targetBrick = this.bricks[i];
          }
        }
        if (targetBrick != undefined)
        {
        // récupération du slot cible
        var targetSlot;
        var targetSlotList = [];
        for (let i = 0; i < targetBrick.slots.length; i++) {
        for (let j = 0; j < targetBrick.slots[i].surfaces.length; j++) {
          
            if (targetBrick.slots[i].surfaces[j] == targetSurface) {
              
              
              targetSlot = targetBrick.slots[i];
            }
          }
          let c = new THREE.Vector3().setFromMatrixPosition(targetBrick.slots[i].mat);
          c.applyMatrix4(targetBrick.mesh.matrixWorld);
          let d = intersects[0].point.distanceTo(c);
          targetBrick.slots[i].dist = d;
          targetSlotList.push(targetBrick.slots[i]);
        }
        }
        function trierTableauParDist(tableau) {
          tableau.sort(function(a, b) {
            return a.dist - b.dist;
          });
        }
        
        trierTableauParDist(targetSlotList);
        if (targetSurface != undefined) stuffs.surface = targetSurface;
        else {
          ////console .log('wtf');
          ////console .log(this.getgroupnumberfromfaceindex (object, faceIndex));
        }
       // if (targetSlot) stuffs.slot = targetSlot;
        if (targetSlotList.length > 0 ) {
          stuffs.slots = targetSlotList;
          stuffs.slot = targetSlotList[0];
        }
        if (targetBrick) stuffs.brick = targetBrick;
        stuffs.faceIndex = faceIndex;
        stuffs.at = intersects[0].point;
        stuffs.mesh = object;
        stuffs.group = targetSurface;
        }
        if (object.isActionner) {
          //console .log('app.tapedStuffs');
          //console .log(app.tapedStuffs);
          stuffs.actioner = object;
          //console .log(object);
         // object.material.color.set('#d00')
  /*        var inputRange = document.createElement("input");
          inputRange.classList.add('custom-slider');
		inputRange.type = "range";
		inputRange.min = "0";
		inputRange.max = "360";
		inputRange.value = "180";
		inputRange.id = "mon-range";

		// Ajouter le nouvel élément input range à la page
		var container = document.getElementById("container");
		this.elem.appendChild(inputRange);*/
		
         // alert('actioners')
        }
    }
    stuffs.from = this;
    return stuffs;
  }
  getgroupnumberfromfaceindex (object, faceIndex) {
  
    for (let i = 0; i < object.geometry.groups.length; i++) {
        if ( (object.geometry.groups[i].start/3) <= faceIndex && faceIndex < (object.geometry.groups[i].start/3 + object.geometry.groups[i].count/3) )
         return i;
    }
  }
  updatebricksslotsmatrix () {
    for (let i = 0; i < this.bricks.length; i++) {
      this.bricks[i].updateslotsmatrix();
    }
  }
  render () {
   // requestAnimationFrame( this.render.bind(this) );
    this.renderer.render(this.scene, this.camera);
  }
}
class Bank {
  constructor(unit) {
    this.colorbank = [
  {name: 'white', def: '#FFFFFF'},

  {name: 'gray-e', def: '#eee'},
  {name: 'gray-c', def: '#ccc'},
  {name: 'gray-a', def: '#aaa'},
  {name:'gray-48', def: '#888'},
  {name: 'gray-6', def: '#666'},
  {name: 'gray-4', def: '#444'},
  {name: 'gray-2', def: '#222'},
  {name: 'black', def: '#000000'},
  {name: 'blue', def: '#0072C6'},
  {name: 'red', def: '#C91A09'},
  {name: 'yellow', def: '#F2CD37'},
  {name: 'green', def: '#00873C'},
  {name: 'gray', def: '#6D6E70'},
  {name: 'brown', def: '#573B21'},
  {name: 'orange', def: '#FFA500'},
  {name: 'purple', def: '#800080'},
  {name: 'pink', def: '#FFC0CB'},
  {name: 'transparent', def: '#B3B3B3'},
  {name: 'silver', def: '#C0C0C0'},
  {name: 'gold', def: '#FFD700'}
];

    this.urlbank = [
      { url:baseUrl + 'bank/con x1 pin x1.json', name: 'con x1 pin x1'},
      { url:baseUrl + 'bank/con x1 pin x1x1.json', name: 'con x1 pin x1x1'},
      { url:baseUrl + 'bank/con x1 pin x2.json', name: 'con x1 pin x2'},
      { url:baseUrl + 'bank/con x1 pin x4.json', name: 'con x1 pin x4'},
      { url:baseUrl + 'bank/con x2.json', name: 'con x2'},
      { url:baseUrl + 'bank/con x2r1.json', name: 'con x2r1'},
      { url:baseUrl + 'bank/con x3r1.json', name: 'con x3r1'},
      { url:baseUrl + 'bank/plate 1x1.json', name: 'plate 1x1'},
      { url:baseUrl + 'bank/plate 1x10.json', name: 'plate 1x10'},
      { url:baseUrl + 'bank/technics brick 1x1.json', name: 'technics brick 1x1'},
      { url:baseUrl + 'bank/plate 2x2 4 pins blue.json', name: 'plate 2x2 4 pins #1'},
      { url:baseUrl + 'bank/technics brick 1x2.json', name: 'technics brick 1x2'},
      { url:baseUrl + 'bank/technics pin b.json', name: 'technics pin b'},
      { url:baseUrl + 'bank/pin x3.json', name: 'pin x3'},
      { url:baseUrl + 'bank/hinge E-f.json', name: 'hinge E-f'},
      { url:baseUrl + 'bank/hunge D-m.json', name: 'hunge D-m'},
      { url:baseUrl + 'bank/plate 1x1 2 pins gold.json', name: 'system plate 1x1 2 pins gold'},
      { url:baseUrl + 'bank/plate hinge 1x2.json', name: 'plate hinge 1x2'},
      { url:baseUrl + 'bank/plate hinge 1x2 f.json', name: 'plate hinge 1x2 f'},
      { url:baseUrl + 'bank/system plate 1x3.json', name: 'system plate 1x3'},
      { url:baseUrl + 'bank/system plate 1x4.json', name: 'system plate 1x4'}
      ];
    this.unit = unit;
    this.version = 1;
    this.modal = null;
    this.modalContent = null;
    // initialisation de l'élément DOM du modal à null
  }
  createModal() {
    // Création de l'élément DOM du modal
    this.modal = createElement('div', '', 'modal');
    const modalContent = createElement('div', '', 'modal-content');
    const modalHeader = createElement('div', 'Save/Load Bank', 'modal-header');
    const modalClose = createElement('span', '<-', 'close');

    // On attache l'événement "click" pour fermer le modal lorsqu'on clique sur le bouton "x"
    modalClose.addEventListener('click', function() {
      this.modal.style.display = 'none';
      this.modalContent.innerHTML = '';
    }.bind(this));

    // On ajoute le contenu du modal à son élément parent
    this.modal.appendChild(modalHeader);
    this.modal.appendChild(modalClose);
    this.modal.appendChild(modalContent);

    // On sauvegarde l'élément DOM du modal dans la propriété "this.modal"
    
    this.modalContent = modalContent;
    // On retourne l'élément DOM du modal pour pouvoir l'insérer dans la page web
    return this.modal;
  }
  bricktounit (b, u) {
    removeChildren( u.buildarea);
    u.bricks = [];
    u.addbrick2 (b);
    app.allunits.render();
  }
  loadmesh (m, u) {
    removeChildren( u.buildarea);
    u.bricks = [];
    u.addvirginbrick(m);
    u.context.addslothandler();
    app.allunits.render();
  }
  list() {
    var blist = createDiv('');
    for (let i = 0; i < window.app.data.bank.length; i++) {
      let loadbtn = createElement(
        'div',
        window.app.data.bank[i].name,
        'btn',
        '',
        '',
        'click',
        function() {
          
          this.bricktounit (window.app.data.bank[i], this.unit);
          this.modal.style.display = 'none';
          this.modalContent.innerHTML = '';
          ////console .log('loading');
          ////console .log(this.unit);
          ////console .log(window.app.data.bank[i]);
        }.bind(this)
      );
      let deletebtn = createElement(
        'span',
        'X',
        '',
        '',
        '',
        'click',
        function() {
          window.app.data.bank.splice(i, 1);
          app.updatedata();
        }.bind(this)
      );
      blist.appendChild(loadbtn);
      loadbtn.appendChild(deletebtn);
    }
    
    return blist;
  }
}
class orbCamControls {
  constructor(unit) {
    this.unit = unit;
    this.rmat = new THREE.Matrix4();
    this.tmat = new THREE.Matrix4();
    this.fmat = new THREE.Matrix4();
    this.domdest = this.unit.elem;
    this.h = this.domdest.clientHeight;
    this.w = this.domdest.clientWidth;
    this.panvelocity = 0;
    this.camera = this.unit.camera;
    //this.scene = this.unit.scene;
    this.scene = this.unit.buildarea;
    this.position = new THREE.Vector3(0, 0, 4);
    this.camera.position.set(0, 0, 4);
    
    this.hammer = new Hammer(this.unit.renderer.domElement);
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.rotation = { x: 0, y: 0 };
    this.updateCamera();

  }
  onTap (event) {
    // Calculer la position du curseur dans l'espace 3D
    
    const elementPos = this.domdest.getBoundingClientRect();

    const mouse = new THREE.Vector2();
    mouse.x = ((event.center.x - elementPos.x) / this.w) * 2 - 1;
    mouse.y = -((event.center.y - elementPos.y) / this.h) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);
    const intersects = raycaster.intersectObjects(this.scene.children, true);
    if (intersects.length > 0) {

      var faceIndex = intersects[0].faceIndex;
      var object = intersects[0].object;
  
      if (faceIndex !== undefined && object !== undefined) {
       
        for (let i = 0; i < this.unit.bricks.length; i++) {
          if ( this.unit.bricks[i].mesh.uuid == object.uuid ) {
            this.unit.selectedbrick = this.unit.bricks[i];
          }
        }
        const material = new THREE.MeshBasicMaterial({color: "#FF0000"});
        const tapevent = new CustomEvent('tap-unit-'+this.unit.uid, {
              detail: {
                message: 'tap-unit-'+this.unit.uid,
                object: object,
                faceIndex: faceIndex
              },
            });
            document.dispatchEvent(tapevent);
      }
    }
  }
  onPanEnd(event) {
    this.rotation.x = 0;
    this.rotation.y = 0;
  }
  onPan(event) {
    this.rotation.x = event.velocityY * 0.4;
    this.rotation.y = event.velocityX * 0.4;
    this.panvelocity = event.velocity;
    this.updateCamera();
  }
  onPinchStart(event) {
    l('cam pinch start');
    l(this.unit);
    this.initilheight = this.unit.getApparentHeight(this.unit.buildarea);
  }
  onPinchEnd(event) {
    l('cam pinch end');
  }
  onPinch(event) {
    l('cam pinch');
    this.zoom *= (1/event.scale)*0.89;
    //this.unit.setCameraDistanceForApparentHeight(this.unit.buildarea, this.initilheight*event.scale);
 //   l(event);
    // -= event.overallVelocity*0.4;
  
  //  this.zoom *= event.scale*0.4;
    this.rotation = {x:0.0, y:0.0};
    this.updateCamera();
  }
  onPress(event) {
    // Reset camera state when user presses
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.rotation = { x: 0, y: 0 };
    this.updateCamera();
  }
  updateCamera() {
    //console.log(this.rotation.x+' '+this.rotation.y);
    const distance = 300 * this.zoom;
    const eulerRotation = new THREE.Euler(this.rotation.x, this.rotation.y, 0);
    const quaternionRotation = new THREE.Quaternion().setFromEuler(eulerRotation);
    this.rmat =new THREE.Matrix4().makeRotationFromQuaternion(quaternionRotation).multiply(this.rmat );
    this.genfinalmatrix ();
    this.scene.matrixAutoUpdate = false;
    this.scene.matrix.copy(this.fmat);
    this.scene.matrixAutoUpdate = false;
    this.unit.render();
  }
  genfinalmatrix () {
    const distance = 300 * this.zoom;
    if (app.tapedStuffs) {
      if (app.tapedStuffs.brick) {
        let t = new THREE.Vector3().setFromMatrixPosition(app.tapedStuffs.brick.mesh.matrix);
        this.tmat = new THREE.Matrix4().makeTranslation( -t.x, -t.y, -t.z );
     //   console.log(this.tmat);
    //    console.log(new THREE.Vector3().setFromMatrixPosition(app.tapedStuffs.brick.mesh.matrix));
  //      console.log(app.tapedStuffs.brick.mesh.position)
      }
    }
    else 
      this.tmat = new THREE.Matrix4();
    this.camera.position.set(0, 0, distance);
    this.fmat.multiplyMatrices(this.rmat, this.tmat);
  }
}
class Application  {
  constructor() {
    
    
    window.app = this;
    this.data = {};
    this.dataversion ='briquesjs-local-data-v8';
    this.loaddata();
  //  this.updatedata();
    this.activeunit = null;
    
    this.resizingunit = false;
    this.dropOnStuffs;
    this.draggedStuffs;
    this.hoveredStuffs;
    this.tapedStuffs;
    this.hoveredSlot;
    this.units = [];
    
    this.apphead = createDiv('', '', 'app-head');
    this.appheadtop = createDiv('', 'app-head-top');
    this.appheadcontent = createDiv('', 'app-head-content');
    
    this.expandappheadbtn = createDiv('+', 'app-head-btn', '', '', 'click', function() {
      this.apphead.classList.toggle('expanded');
    }.bind(this));
    this.appheadtop.appendChild(this.expandappheadbtn);
    this.unitrestorebtn = createDiv('restore', 'app-head-btn', '', '', 'click', function() {
      app.restoreUnitState();
    });
    this.appheadtop.appendChild(this.unitrestorebtn);
    
    this.unitadderbtn = createDiv('add workspace', 'app-head-btn', '', '', 'click', function() {
      /*
      this.units.push(new Unit( this.unitsboard ));
      this.activeunit = this.units[this.units.length-1];
      let anhammer = new Hammer ( this.units[this.units.length-1].renderer.domElement );
    anhammer.get('pan').set({ direction: Hammer.DIRECTION_ALL, preventDefault: true  });
    anhammer.on('pan', this.ontrace.bind(this));
    anhammer.on('tap', this.ontap.bind(this));
    anhammer.on('panstart', this.ontracestart.bind(this));
   // this.apphead.appendChild(this.unitadderbtn);
    anhammer.on('panend', this.ontraceend.bind(this));
    anhammer.on('pancancel', this.ontraceend.bind(this));
    anhammer.get('pinch').set({ enable: true });
    anhammer.on('pinch', this.onPinch.bind(this));
    */
    this.addunit();
    }.bind(this));
    this.appheadtop.appendChild(this.unitadderbtn);
    this.apphead.appendChild(this.appheadtop);
    this.apphead.appendChild(this.appheadcontent);
    this.appmouse = createDiv('', '', 'app-mouse');
    
    document.body.appendChild(this.apphead);
    this.unitsboard = createDiv('', '', 'units-board');
    document.body.appendChild(this.unitsboard);

    this.allunits = {
      render : () => {
        for (let i = 0; i < this.units.length; i++) {
          this.units[i].render();
        }},
      hidebottomrightcorner : () => {
        for (let i = 0; i < this.units.length; i++) {
          this.units[i].bottomrighthandler.style.background = '#4441';
          this.units[i].toplefthandler.style.background = '#4441';
        }
      }
    }
   
   this.tracemanager();
   
  }
  tracemanager () {
    
  for (let i = 0; i < this.units.length; i++) {
    let anhammer = new Hammer ( this.units[i].renderer.domElement );
    anhammer.get('pan').set({ direction: Hammer.DIRECTION_ALL, preventDefault: true  });
    anhammer.on('pan', this.ontrace.bind(this));
    anhammer.on('tap', this.ontap.bind(this));
    anhammer.on('panstart', this.ontracestart.bind(this));
    anhammer.on('panend', this.ontraceend.bind(this));
    anhammer.on('pancancel', this.ontraceend.bind(this));
    /*anhammer.get('pinch').set({ enable: true });
    anhammer.on('pinchstart', function (e) {
      l(',00');
      l(e);
    this.onPinchStart();
    }.bind(this));
    anhammer.on('pinch', function (e) {
      l('pinch');
      l(e);
    this.onPinch();
    }.bind(this));
    anhammer.on('pinchend', this.onPinchEnd.bind(this));*/
   // anhammer.on('pinch', this.onPinch.bind(this));
  }

  }
  ontracestart (event) {
 //    app.unitsboard.style.overflow = 'hidden';
    let center = new THREE.Vector2();
    center.x = event.center.x;
    center.y = event.center.y;
    
    for (let i = 0; i < this.units.length; i++) {
      let unit = this.units[i];
      const elementPos = unit.elem.getBoundingClientRect();
      
      
      if ( ( elementPos.x < center.x && center.x < ( elementPos.x + elementPos.width ) ) &&
           ( elementPos.y < center.y && center.y < ( elementPos.y + elementPos.height ) ) )
      {
        this.activeunit = this.units[i];
        console .log( 'trace start on : '+i);
        this.activeunit.ontracestart(event);
        if (this.units[i].elem.classList.contains('active') != true)
        this.units[i].elem.classList.add('active');
      }
      else {
        this.units[i].elem.classList.remove('active');
      }
    }
    
  }
  onPinchStart(event) {
    this.activeunit.onpinchstart(event);
  }
  onPinchEnd(event) {
    this.activeunit.onpinchend(event);
  }
  onPinch(event) {
    this.activeunit.onpinch(event);
  }
  ontraceend (event) {
    for (let i = 0; i < this.units.length; i++)
      this.units[i].statebar.style.color = '#fff';
          let center = new THREE.Vector2();
    center.x = event.center.x;
    center.y = event.center.y;
    
    for (let i = 0; i < this.units.length; i++) {
      let unit = this.units[i];
      const elementPos = unit.elem.getBoundingClientRect();
      
      
      if ( ( elementPos.x < center.x && center.x < ( elementPos.x + elementPos.width ) ) &&
           ( elementPos.y < center.y && center.y < ( elementPos.y + elementPos.height ) ) )
      {
        this.activeunit = this.units[i];
        this.activeunit.ontraceend(event);
        this.activeunit.elem.classList.toggle('active');
      }
      else {
        this.activeunit.elem.classList.remove('active');
      }
    }
    
  }
  ontrace (event) {
    //app.unitsboard.style.overflow = 'hidden';
    let center = new THREE.Vector2();
    center.x = event.center.x;
    center.y = event.center.y;
    
    for (let i = 0; i < this.units.length; i++) {
      let unit = this.units[i];
      const elementPos = unit.elem.getBoundingClientRect();
      
      
      if ( ( elementPos.x < center.x && center.x < ( elementPos.x + elementPos.width ) ) &&
           ( elementPos.y < center.y && center.y < ( elementPos.y + elementPos.height ) ) )
      {
        this.activeunit = this.units[i];
        this.activeunit.ontrace(event);
        if (this.activeunit.elem.classList.contains('active') != true)
        this.activeunit.elem.classList.add('active');
      }
      else {
        if (this.activeunit.elem.classList.contains('active') == true)
        this.activeunit.elem.classList.remove('active');
      }
    }
   // console.log(this.activeunit);
  }
  ontap(event) {
    let center = new THREE.Vector2();
    center.x = event.center.x;
    center.y = event.center.y;
    
    for (let i = 0; i < this.units.length; i++) {
      let unit = this.units[i];
      const elementPos = unit.elem.getBoundingClientRect();
      
      
      if ( ( elementPos.x < center.x && center.x < ( elementPos.x + elementPos.width ) ) &&
           ( elementPos.y < center.y && center.y < ( elementPos.y + elementPos.height ) ) )
      {
        this.activeunit = this.units[i];
        this.activeunit.ontap(event);
        if (this.activeunit.elem.classList.contains('active') != true)
        this.activeunit.elem.classList.toggle('active');
      }
      else {
        if (this.activeunit.elem.classList.contains('active') == true)
        this.activeunit.elem.classList.remove('active');
      }
    }
  }
  
  addunit () {
    this.units.push(new Unit( this.unitsboard ));
      this.activeunit = this.units[this.units.length-1]; 
      let anhammer = new Hammer ( this.units[this.units.length-1].renderer.domElement );
    anhammer.on('tap', this.ontap.bind(this));
    
    anhammer.get('pan').set({ direction: Hammer.DIRECTION_ALL, preventDefault: true  });
    anhammer.on('panstart', this.ontracestart.bind(this));
    anhammer.on('pan', this.ontrace.bind(this));
    anhammer.on('panend', this.ontraceend.bind(this));
    anhammer.on('pancancel', this.ontraceend.bind(this));
    
    anhammer.get('pinch').set({ enable: true });
    anhammer.on('pinch', this.onPinch.bind(this));
    anhammer.on('pinchstart', this.onPinchStart.bind(this));
    anhammer.on('pinchend', this.onPinchEnd.bind(this));
  }
  saveUnitState (unit, statenumber) {
    let bricks = [];
    for (let i = 0; i < unit.bricks.length; i++) {
      bricks.push(
      { brickname: unit.bricks[i].name,
        brickcolor: unit.bricks[i].color,
        mat: [...unit.bricks[i].mesh.matrix.elements]
      });
      
    }
    let unitstate = {
      bricks : bricks,
      timestamp : Date.now()
    }
    app.data.unitstates.push(unitstate);
    console.log(app.data);
    this.updatedata();
    
    
    
    
  }
  
  objFromJsonFile () {
  // ================∞==========÷==÷=============
  // Création de l'élément <input> de type "file"
  // ================∞==========÷==÷=============
    
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = 'none';
    function handleFileSelect(event) {
      const files = event.target.files;
      const reader = new FileReader();
      // Fonction appelée lorsque le fichier est chargé
      reader.onload = function(e) {
        
        const stateData = e.target.result;
        this.loadUnitState (JSON.parse(stateData));
      }.bind(this)
      reader.readAsText(files[0]);
    }
    input.addEventListener("change", handleFileSelect.bind(this), false);
    input.click();
    
    
  }
  objToJsonFile (obj, name) {
    // Création d'un objet de type "blob" représentant les données du maillage
     const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
      // Création d'une URL permettant de télécharger le blob sous forme de fichier
      const url = URL.createObjectURL(blob);
      // Création d'un élément <a> pour déclencher le téléchargement du fichier
      const link = document.createElement("a");
      link.href = url;
      link.download = name+'.json';
      // Ajout de l'élément <a> au DOM et déclenchement du téléchargement
      document.body.appendChild(link);
      link.click();
      // Nettoyage de l'URL créée
      URL.revokeObjectURL(url);
    }
  restoreUnitState (unit, statenumber) {
    let state = app.data.unitstates[app.data.unitstates.length-1];
          
      this.units.push(new Unit( this.unitsboard ));
      this.activeunit = this.units[this.units.length-1];
      let anhammer = new Hammer ( this.units[this.units.length-1].renderer.domElement );
    anhammer.get('pan').set({ direction: Hammer.DIRECTION_ALL, preventDefault: true  });
    anhammer.on('pan', this.ontrace.bind(this));
    anhammer.on('tap', this.ontap.bind(this));
    anhammer.on('panstart', this.ontracestart.bind(this));
    
    anhammer.on('panend', this.ontraceend.bind(this));
    anhammer.on('pancancel', this.ontraceend.bind(this));
    anhammer.get('pinch').set({ enable: true });
    anhammer.on('pinch', this.onPinch.bind(this));
    
    for (let i = 0; i < state.bricks.length; i++) {
      let url = baseUrl + 'bank/'+state.bricks[i].brickname+'.json';
         getJSON(url, function (data)  {
         this.units[ this.units.length-1 ].addpositionedjsonbrick(data,state.bricks[i].mat, state.bricks[i].brickcolor)
        }.bind(this));
    }
          
          
          
  }
  loadUnitState (state) {
      this.units.push(new Unit( this.unitsboard ));
      this.activeunit = this.units[this.units.length-1];
      let anhammer = new Hammer ( this.units[this.units.length-1].renderer.domElement );
    anhammer.get('pan').set({ direction: Hammer.DIRECTION_ALL, preventDefault: true  });
    anhammer.on('pan', this.ontrace.bind(this));
    anhammer.on('tap', this.ontap.bind(this));
    anhammer.on('panstart', this.ontracestart.bind(this));
    
    anhammer.on('panend', this.ontraceend.bind(this));
    anhammer.on('pancancel', this.ontraceend.bind(this));
    anhammer.get('pinch').set({ enable: true });
    anhammer.on('pinch', this.onPinch.bind(this));
    
    for (let i = 0; i < state.bricks.length; i++) {
      let url = baseUrl + 'bank/'+state.bricks[i].brickname+'.json';
         getJSON(url, function (data)  {
         this.units[ this.units.length-1 ].addpositionedjsonbrick(data,state.bricks[i].mat, state.bricks[i].brickcolor)
        }.bind(this));
    }
          
          
          
  }
  loaddata () {
    const localdata = localStorage.getItem(this.dataversion);
    if  (localdata != 'exist')
    {
      l ('create localstorage :');
      localStorage.setItem(this.dataversion, 'exist');
      this.dataRAZ();
    }
    else
    {
      this.data = JSON.parse(localStorage.getItem('briquesjs-data'));
      l('local storage founded', 2);

    }
  }
  dataRAZ () {
    this.data = {
        username: window.username,
        bank: [],
        unitstates: []
      };
    this.updatedata();
  }
  updatedata () {
    let tmp = JSON.stringify(this.data);
      localStorage.setItem('briquesjs-data', tmp);
  }
  renderAllUnits () {
    for (let i = 0; i < this.units.length; i++) {
      this.units[i].render();
    }
  }
}


// Vérifier la prise en charge de l'API
if ('AmbientLightSensor' in window) {
  // Demander l'autorisation d'accès au capteur
  navigator.permissions.query({ name: 'ambient-light-sensor' })
    .then(result => {
      if (result.state === 'granted') {
        // Créer une instance du capteur
        const sensor = new AmbientLightSensor();

        // Écouter les changements de luminosité
        sensor.addEventListener('reading', () => {
          console.log('Luminosité ambiante :', sensor.illuminance);
        });

        // Activer le capteur
        sensor.start();
      } else {
        console.log('Accès au capteur de luminosité refusé');
      }
    })
    .catch(err => {
      console.error('Erreur lors de l\'accès au capteur :', err);
    });
} else {
  console.log('API de luminosité ambiante non prise en charge');
}

const isPWA = window.matchMedia('(display-mode: standalone)').matches;
//if ( isPWA )
if ( true )
{
  l('./application');
  localStorage.setItem('threeJsStarterPWA', 'installed');
  app  = new Application ();
  window.logctnr.classList.add('sleeped');
}
else {
  if ( localStorage.getItem('threeJsStarterPWA') == 'installed') 
    l('l\'application est deja installée', 3);
  else
    l('vous pouvez installer l\'application', 2);
}