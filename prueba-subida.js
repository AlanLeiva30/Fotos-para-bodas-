/*
 * Héctor & Martha — Página interna de pruebas de subida (Etapa B)
 *
 * - Independiente de la aplicación: no usa ni modifica script.js.
 * - No contiene la URL del servidor ni la clave: se escriben en la página
 *   y se guardan solo en este navegador (localStorage).
 * - Envía con fetch POST "simple" (cuerpo de texto, sin cabeceras propias,
 *   sin cookies) para evitar la consulta previa de CORS, y sigue la
 *   redirección de Apps Script hacia script.googleusercontent.com.
 * - Una foto solo se considera guardada si el servidor responde ok:true
 *   Y coinciden el servicio, el id y el tamaño en bytes.
 * - El registro nunca incluye la clave ni el contenido de la fotografía.
 */
(function () {
  'use strict';

  /* ---------- Constantes ---------- */

  const SERVICIO = 'hector-martha-pruebas';

  // Optimización en el teléfono.
  const LADO_MAXIMO = 2560;
  const CALIDAD = 0.85;
  const LADO_REDUCIDO = 2048;
  const CALIDAD_REDUCIDA = 0.75;
  const LIMITE_OPTIMIZADA = 4 * 1024 * 1024;   // si se supera, se reduce más
  const LIMITE_SERVIDOR = 8 * 1024 * 1024;     // el servidor rechaza más de 8 MB

  // Red.
  const TIEMPO_LIMITE_MS = 60000;
  const ESPERAS_REINTENTO_MS = [2000, 5000, 10000];
  const CORTE_PRUEBA_MS = 2500;  // "Enviar y cortar la respuesta"

  // Códigos del servidor que son temporales: se reintenta con el mismo id.
  const REINTENTABLES = ['ocupado', 'en-proceso', 'limite-minuto', 'error-guardado', 'verificacion-fallida', 'error-interno'];

  // Solo se aceptan URLs de aplicaciones web de Apps Script terminadas en /exec.
  const PATRON_URL = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[A-Za-z0-9_-]+\/exec$/;

  const ALMACEN_URL = 'hm-prueba-url';
  const ALMACEN_CLAVE = 'hm-prueba-clave';

  /* ---------- Elementos ---------- */

  const $ = function (id) { return document.getElementById(id); };
  const el = {
    url: $('cfg-url'),
    clave: $('cfg-clave'),
    guardar: $('btn-guardar-config'),
    olvidar: $('btn-olvidar-config'),
    entorno: $('entorno'),
    get: $('btn-get'),
    post: $('btn-post'),
    mensajeB1: $('mensaje-b1'),
    tomar: $('btn-tomar'),
    elegir: $('btn-elegir'),
    inputTomar: $('input-tomar'),
    inputElegir: $('input-elegir'),
    preparada: $('foto-preparada'),
    vista: $('foto-vista'),
    datosFoto: $('foto-datos'),
    enviar: $('btn-enviar'),
    reenviar: $('btn-reenviar'),
    cortar: $('btn-cortar'),
    claveMala: $('btn-clave-mala'),
    mensajeFoto: $('mensaje-foto'),
    copiar: $('btn-copiar'),
    limpiar: $('btn-limpiar'),
    registro: $('registro')
  };

  const botonesDeRed = [el.get, el.post, el.enviar, el.reenviar, el.cortar, el.claveMala, el.tomar, el.elegir];

  let foto = null;        // { id, blob, base64, ancho, alto, original, vistaUrl, enviada }
  let trabajando = false;
  const lineasRegistro = [];

  /* ---------- Utilidades ---------- */

  function leerAlmacen(clave) {
    try { return localStorage.getItem(clave) || ''; } catch (e) { return ''; }
  }
  function escribirAlmacen(clave, valor) {
    try {
      if (valor) localStorage.setItem(clave, valor);
      else localStorage.removeItem(clave);
      return true;
    } catch (e) { return false; }
  }

  function formatearTamano(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function esperar(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function hora() {
    const d = new Date();
    return d.toTimeString().slice(0, 8);
  }

  function hostDe(url) {
    try { return new URL(url).host; } catch (e) { return '(desconocido)'; }
  }

  // Id aleatorio de 32 caracteres hexadecimales (una vez por foto).
  function nuevoId() {
    if (window.crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '');
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function mostrarMensaje(nodo, texto, tipo) {
    nodo.textContent = texto;
    nodo.className = 'mensaje resultado' + (tipo ? ' mensaje-' + tipo : '');
    nodo.hidden = false;
  }

  function ocupado(valor) {
    trabajando = valor;
    botonesDeRed.forEach(function (b) { b.disabled = valor; });
    if (!valor) actualizarBotonesFoto();
  }

  function actualizarBotonesFoto() {
    if (!foto) return;
    el.enviar.disabled = trabajando || foto.enviada;
    el.reenviar.disabled = trabajando || !foto.enviada;
  }

  /* ---------- Registro (sin clave ni fotografía) ---------- */

  function registrar(titulo, detalle) {
    const linea = '[' + hora() + '] ' + titulo + (detalle ? '\n' + detalle : '');
    lineasRegistro.push(linea);

    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = '[' + hora() + '] ' + titulo;
    li.appendChild(strong);
    if (detalle) {
      const pre = document.createElement('pre');
      pre.className = 'datos';
      pre.textContent = detalle;
      li.appendChild(pre);
    }
    el.registro.insertBefore(li, el.registro.firstChild);
  }

  function describirDiagnostico(r) {
    const d = r.diag || {};
    const partes = [];
    if (d.estado !== undefined) partes.push('HTTP ' + d.estado + ' · tipo ' + d.tipo + ' · redirigida ' + (d.redirigida ? 'sí' : 'no'));
    if (d.hostFinal) partes.push('Respondió: ' + d.hostFinal);
    if (d.contentType) partes.push('Content-Type: ' + d.contentType);
    if (d.ms !== undefined) partes.push('Tiempo: ' + d.ms + ' ms');
    if (r.json) partes.push('JSON: ' + JSON.stringify(r.json));
    if (r.motivo) partes.push('Motivo: ' + r.motivo);
    if (r.error) partes.push('Error del navegador: ' + r.error);
    if (r.extracto) partes.push('Inicio de la respuesta (no es JSON): ' + r.extracto);
    return partes.join('\n');
  }

  /* ---------- Configuración ---------- */

  function configActual() {
    return { url: el.url.value.trim(), clave: el.clave.value.trim() };
  }

  function validarConfig(necesitaClave) {
    const cfg = configActual();
    if (!PATRON_URL.test(cfg.url)) {
      return { error: 'La URL debe ser la de la aplicación web de Apps Script y terminar en /exec (la de /dev no sirve para invitados).' };
    }
    if (necesitaClave && !/^[A-Za-z0-9_-]{6,64}$/.test(cfg.clave)) {
      return { error: 'Escribe la clave pública del evento (está en Propiedades del script → CLAVE_EVENTO).' };
    }
    return { cfg: cfg };
  }

  function mostrarEntorno() {
    const lineas = [
      'Origen de esta página: ' + location.origin,
      'Conexión segura (HTTPS): ' + (window.isSecureContext ? 'sí' : 'NO'),
      'crypto.randomUUID: ' + (window.crypto && crypto.randomUUID ? 'sí' : 'no (se usa alternativa)'),
      'En línea: ' + (navigator.onLine ? 'sí' : 'no'),
      'Navegador: ' + navigator.userAgent
    ];
    el.entorno.textContent = lineas.join('\n');
  }

  el.url.value = leerAlmacen(ALMACEN_URL);
  el.clave.value = leerAlmacen(ALMACEN_CLAVE);

  el.guardar.addEventListener('click', function () {
    const v = validarConfig(true);
    if (v.error) {
      mostrarMensaje(el.mensajeB1, v.error, 'error');
      return;
    }
    const ok = escribirAlmacen(ALMACEN_URL, v.cfg.url) && escribirAlmacen(ALMACEN_CLAVE, v.cfg.clave);
    mostrarMensaje(el.mensajeB1, ok
      ? 'Configuración guardada en este dispositivo.'
      : 'No se pudo guardar en este navegador (modo privado). Funciona igual mientras la página esté abierta.', ok ? 'exito' : '');
  });

  el.olvidar.addEventListener('click', function () {
    escribirAlmacen(ALMACEN_URL, '');
    escribirAlmacen(ALMACEN_CLAVE, '');
    el.url.value = '';
    el.clave.value = '';
    mostrarMensaje(el.mensajeB1, 'Configuración borrada de este dispositivo.', '');
  });

  /* ---------- Comunicación con Apps Script ---------- */

  /**
   * Hace una petición y devuelve SIEMPRE un objeto (nunca lanza):
   *   { respondio: true, json, diag }                → se leyó un JSON
   *   { respondio: false, motivo, diag, error? }     → sin confirmar
   */
  async function llamarServidor(url, metodo, cuerpo, cortarEnMs) {
    const controlador = new AbortController();
    let motivoCorte = null;
    const limite = setTimeout(function () { motivoCorte = 'tiempo-agotado'; controlador.abort(); }, TIEMPO_LIMITE_MS);
    const corte = cortarEnMs
      ? setTimeout(function () { motivoCorte = 'corte-manual-de-prueba'; controlador.abort(); }, cortarEnMs)
      : null;

    const opciones = {
      method: metodo,
      redirect: 'follow',
      credentials: 'omit',   // sin cookies de Google
      cache: 'no-store',
      signal: controlador.signal
    };
    // Cuerpo de texto SIN cabeceras propias: viaja como text/plain (petición simple, sin preflight).
    if (cuerpo !== null) opciones.body = cuerpo;

    const inicio = Date.now();
    const diag = {};
    try {
      const respuesta = await fetch(url, opciones);
      diag.estado = respuesta.status;
      diag.tipo = respuesta.type;
      diag.redirigida = respuesta.redirected;
      diag.hostFinal = hostDe(respuesta.url);
      diag.contentType = respuesta.headers.get('content-type') || '';
      const texto = await respuesta.text();
      diag.ms = Date.now() - inicio;

      let json = null;
      try { json = JSON.parse(texto); } catch (e) { json = null; }
      if (!json || typeof json !== 'object') {
        return { respondio: false, motivo: 'respuesta-no-json', diag: diag, extracto: texto.slice(0, 160) };
      }
      return { respondio: true, json: json, diag: diag };
    } catch (error) {
      diag.ms = Date.now() - inicio;
      const motivo = motivoCorte || (navigator.onLine === false ? 'sin-conexion' : 'red-o-cors-bloqueado');
      return { respondio: false, motivo: motivo, diag: diag, error: (error && error.name) + ': ' + (error && error.message) };
    } finally {
      clearTimeout(limite);
      if (corte) clearTimeout(corte);
    }
  }

  /* ---------- Fase B1: GET ---------- */

  el.get.addEventListener('click', async function () {
    const v = validarConfig(false);
    if (v.error) { mostrarMensaje(el.mensajeB1, v.error, 'error'); return; }

    ocupado(true);
    mostrarMensaje(el.mensajeB1, 'Probando GET…', '');
    const r = await llamarServidor(v.cfg.url, 'GET', null, 0);
    ocupado(false);

    if (r.respondio && r.json.ok === true && r.json.servicio === SERVICIO) {
      mostrarMensaje(el.mensajeB1, '✅ GET correcto: el navegador leyó el JSON del servidor (' + r.diag.ms + ' ms).', 'exito');
      registrar('GET ✅ leído correctamente', describirDiagnostico(r));
    } else {
      mostrarMensaje(el.mensajeB1, '❌ GET sin respuesta legible (' + (r.motivo || 'respuesta inesperada') + '). Revisa el registro.', 'error');
      registrar('GET ❌ falló', describirDiagnostico(r));
    }
  });

  /* ---------- Fase B1: POST con imagen mínima ---------- */

  // JPEG diminuto (64×64, color salvia) generado en el navegador.
  function jpegMinimo() {
    return new Promise(function (resolve) {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#89967B';
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#FAF6EE';
      ctx.beginPath();
      ctx.arc(32, 32, 16, 0, Math.PI * 2);
      ctx.fill();
      canvas.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', 0.9);
    });
  }

  el.post.addEventListener('click', async function () {
    const v = validarConfig(true);
    if (v.error) { mostrarMensaje(el.mensajeB1, v.error, 'error'); return; }

    ocupado(true);
    mostrarMensaje(el.mensajeB1, 'Probando POST…', '');
    const blob = await jpegMinimo();
    const base64 = await blobABase64(blob);
    const id = nuevoId();
    const cuerpo = JSON.stringify({ clave: v.cfg.clave, id: id, tipo: 'image/jpeg', datos: base64 });
    const r = await llamarServidor(v.cfg.url, 'POST', cuerpo, 0);
    ocupado(false);

    const detalle = 'id: ' + id + ' · ' + formatearTamano(blob.size) + '\n' + describirDiagnostico(r);
    if (!r.respondio || r.json.servicio !== SERVICIO) {
      mostrarMensaje(el.mensajeB1, '❌ POST sin respuesta legible (' + (r.motivo || 'respuesta inesperada') + '). Revisa el registro.', 'error');
      registrar('POST ❌ falló', detalle);
    } else if (r.json.codigo === 'subidas-desactivadas') {
      mostrarMensaje(el.mensajeB1, '✅ POST correcto: el navegador leyó la respuesta «subidas-desactivadas». No se creó nada.', 'exito');
      registrar('POST ✅ leído (subidas desactivadas, como se espera en B1)', detalle);
    } else if (r.json.ok === true) {
      mostrarMensaje(el.mensajeB1, '⚠️ POST leído, pero las subidas están ACTIVAS y se guardó la imagen mínima. Revisa el interruptor.', 'error');
      registrar('POST ⚠️ subidas ACTIVAS: se guardó una imagen mínima', detalle);
    } else {
      mostrarMensaje(el.mensajeB1, 'ℹ️ POST leído correctamente. El servidor respondió «' + r.json.codigo + '».', '');
      registrar('POST ℹ️ leído: ' + r.json.codigo, detalle);
    }
  });

  /* ---------- Optimización de la fotografía ---------- */

  function blobABase64(blob) {
    return new Promise(function (resolve, reject) {
      const lector = new FileReader();
      lector.onload = function () { resolve(String(lector.result).split(',')[1] || ''); };
      lector.onerror = function () { reject(lector.error); };
      lector.readAsDataURL(blob);
    });
  }

  function cargarImagen(archivo) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(archivo);
      const img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('no-se-pudo-leer')); };
      img.src = url;
    });
  }

  // Dibuja la imagen (con la orientación correcta) y la guarda como JPEG.
  // El JPEG del canvas NO lleva ubicación GPS ni otros metadatos.
  function aJpeg(img, lado, calidad) {
    return new Promise(function (resolve) {
      const w0 = img.naturalWidth;
      const h0 = img.naturalHeight;
      const escala = Math.min(1, lado / Math.max(w0, h0));
      const ancho = Math.max(1, Math.round(w0 * escala));
      const alto = Math.max(1, Math.round(h0 * escala));
      const canvas = document.createElement('canvas');
      canvas.width = ancho;
      canvas.height = alto;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF'; // fondo blanco por si la imagen tiene transparencia
      ctx.fillRect(0, 0, ancho, alto);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, ancho, alto);
      canvas.toBlob(function (blob) {
        canvas.width = 0;   // liberar memoria (importante en iPhone)
        canvas.height = 0;
        resolve(blob ? { blob: blob, ancho: ancho, alto: alto } : null);
      }, 'image/jpeg', calidad);
    });
  }

  async function prepararFoto(archivo) {
    if (!archivo) return;
    ocupado(true);
    mostrarMensaje(el.mensajeFoto, 'Optimizando la fotografía…', '');
    const inicio = Date.now();

    let carga;
    try {
      carga = await cargarImagen(archivo);
    } catch (e) {
      ocupado(false);
      mostrarMensaje(el.mensajeFoto, 'Este navegador no pudo leer la fotografía (por ejemplo, HEIC en Chrome). Prueba con otra.', 'error');
      registrar('Foto ❌ no se pudo leer', 'Tipo: ' + (archivo.type || 'desconocido') + ' · ' + formatearTamano(archivo.size));
      return;
    }

    let resultado = await aJpeg(carga.img, LADO_MAXIMO, CALIDAD);
    if (resultado && resultado.blob.size > LIMITE_OPTIMIZADA) {
      resultado = await aJpeg(carga.img, LADO_REDUCIDO, CALIDAD_REDUCIDA);
    }
    URL.revokeObjectURL(carga.url);

    if (!resultado || resultado.blob.size > LIMITE_SERVIDOR) {
      ocupado(false);
      mostrarMensaje(el.mensajeFoto, 'No se pudo optimizar la fotografía. Prueba con otra.', 'error');
      registrar('Foto ❌ no se pudo optimizar', '');
      return;
    }

    if (foto && foto.vistaUrl) URL.revokeObjectURL(foto.vistaUrl);
    foto = {
      id: nuevoId(),
      blob: resultado.blob,
      base64: await blobABase64(resultado.blob),
      ancho: resultado.ancho,
      alto: resultado.alto,
      original: { tipo: archivo.type || 'desconocido', tamano: archivo.size },
      vistaUrl: URL.createObjectURL(resultado.blob),
      enviada: false
    };

    const resumen =
      'Original: ' + foto.original.tipo + ' · ' + formatearTamano(foto.original.tamano) + '\n' +
      'Optimizada: image/jpeg · ' + foto.ancho + '×' + foto.alto + ' px · ' + formatearTamano(foto.blob.size) +
      ' (' + foto.blob.size + ' bytes)\n' +
      'id: ' + foto.id + '\n' +
      'Preparada en ' + (Date.now() - inicio) + ' ms';

    el.vista.src = foto.vistaUrl;
    el.datosFoto.textContent = resumen;
    el.preparada.hidden = false;
    el.mensajeFoto.hidden = true;
    registrar('Foto preparada', resumen);
    ocupado(false);
  }

  function abrirSelector(input) {
    input.value = '';
    input.click();
  }

  el.tomar.addEventListener('click', function () { abrirSelector(el.inputTomar); });
  el.elegir.addEventListener('click', function () { abrirSelector(el.inputElegir); });
  el.inputTomar.addEventListener('change', function (e) { prepararFoto(e.target.files && e.target.files[0]); });
  el.inputElegir.addEventListener('change', function (e) { prepararFoto(e.target.files && e.target.files[0]); });

  /* ---------- Envío con confirmación real y reintentos ---------- */

  // Decide qué significa una respuesta para la foto enviada.
  function evaluar(r, fotoEnviada) {
    if (!r.respondio) {
      return { final: false, estado: 'sin-confirmar', texto: 'Sin confirmar (' + r.motivo + ')' };
    }
    const j = r.json;
    if (j.servicio !== SERVICIO) {
      return { final: true, estado: 'error', texto: 'Respuesta de un servicio desconocido' };
    }
    if (j.ok === true) {
      if (j.id !== fotoEnviada.id || j.tamano !== fotoEnviada.blob.size) {
        return { final: true, estado: 'error', texto: 'La respuesta no coincide con la foto enviada (id o tamaño)' };
      }
      return {
        final: true,
        estado: 'guardada',
        texto: j.duplicado ? 'Ya estaba guardada: no se duplicó (ref ' + j.referencia + ')' : 'Guardada en Drive (ref ' + j.referencia + ')'
      };
    }
    if (REINTENTABLES.indexOf(j.codigo) !== -1) {
      return { final: false, estado: 'temporal', texto: 'Error temporal: ' + j.codigo };
    }
    return { final: true, estado: 'rechazada', texto: 'Rechazada: ' + j.codigo + ' — ' + j.mensaje };
  }

  async function enviarFoto(opciones) {
    const v = validarConfig(true);
    if (v.error) { mostrarMensaje(el.mensajeFoto, v.error, 'error'); return; }
    if (!foto || trabajando) return;

    const clave = opciones.claveIncorrecta ? 'clave-incorrecta-de-prueba' : v.cfg.clave;
    const cuerpo = JSON.stringify({ clave: clave, id: foto.id, tipo: 'image/jpeg', datos: foto.base64 });
    const etiqueta = opciones.etiqueta;

    ocupado(true);
    foto.enviada = true;
    let veredicto = null;

    for (let intento = 0; intento <= ESPERAS_REINTENTO_MS.length; intento++) {
      mostrarMensaje(el.mensajeFoto, etiqueta + ': intento ' + (intento + 1) + '…', '');
      const cortar = intento === 0 && opciones.cortar ? CORTE_PRUEBA_MS : 0;
      const r = await llamarServidor(v.cfg.url, 'POST', cuerpo, cortar);
      veredicto = evaluar(r, foto);
      registrar(etiqueta + ' · intento ' + (intento + 1) + ' · ' + veredicto.texto,
        'id: ' + foto.id + ' · ' + foto.blob.size + ' bytes\n' + describirDiagnostico(r));

      if (veredicto.final) break;
      if (intento < ESPERAS_REINTENTO_MS.length) {
        const espera = ESPERAS_REINTENTO_MS[intento];
        mostrarMensaje(el.mensajeFoto, veredicto.texto + '. Reintentando en ' + espera / 1000 + ' s con el mismo id…', '');
        await esperar(espera);
      }
    }

    if (veredicto.estado === 'guardada') {
      mostrarMensaje(el.mensajeFoto, '✅ ' + veredicto.texto, 'exito');
    } else if (veredicto.final) {
      mostrarMensaje(el.mensajeFoto, (veredicto.estado === 'rechazada' ? 'ℹ️ ' : '❌ ') + veredicto.texto, veredicto.estado === 'rechazada' ? '' : 'error');
    } else {
      mostrarMensaje(el.mensajeFoto, '⚠️ ' + veredicto.texto + '. La foto sigue aquí: usa «Reenviar la misma».', 'error');
    }
    ocupado(false);
  }

  el.enviar.addEventListener('click', function () { enviarFoto({ etiqueta: 'Enviar' }); });
  el.reenviar.addEventListener('click', function () { enviarFoto({ etiqueta: 'Reenviar (mismo id)' }); });
  el.cortar.addEventListener('click', function () { enviarFoto({ etiqueta: 'Enviar y cortar', cortar: true }); });
  el.claveMala.addEventListener('click', function () { enviarFoto({ etiqueta: 'Clave incorrecta', claveIncorrecta: true }); });

  /* ---------- Registro: copiar y limpiar ---------- */

  el.copiar.addEventListener('click', function () {
    const texto = lineasRegistro.join('\n\n') || '(registro vacío)';
    const listo = function () { el.copiar.textContent = 'Copiado ✓'; setTimeout(function () { el.copiar.textContent = 'Copiar registro'; }, 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(listo, function () { window.prompt('Copia el registro:', texto); });
    } else {
      window.prompt('Copia el registro:', texto);
    }
  });

  el.limpiar.addEventListener('click', function () {
    lineasRegistro.length = 0;
    el.registro.textContent = '';
  });

  window.addEventListener('online', mostrarEntorno);
  window.addEventListener('offline', mostrarEntorno);
  mostrarEntorno();
})();
