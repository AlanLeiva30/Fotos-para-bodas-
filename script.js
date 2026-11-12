/*
 * Boda Alfaro & Vásquez
 * Etapa 1: captura y selección de fotografías.
 * Etapa 2: confirmación de la fotografía ("Sí, compartir fotografía").
 * Etapa 3: galería temporal de las fotografías confirmadas.
 * Etapa 4: cámara integrada en la página (getUserMedia), con respaldo a la
 *          cámara nativa del teléfono cuando no está disponible.
 * Etapa C: envío a Google Drive (Google Apps Script) SOLO después de que el
 *          invitado pulsa «Sí, compartir fotografía».
 *
 * Antes de confirmar, todo ocurre en el navegador: la vista previa usa
 * URL.createObjectURL (referencia local temporal que se libera al cancelar).
 * Al confirmar, la foto se optimiza en el teléfono (JPEG ≤ 2560 px, sin
 * ubicación GPS ni otros metadatos) y se envía al servidor con un id único
 * que se repite en cada reintento, para que nunca se guarde dos veces.
 * Solo se muestra «compartida» cuando el servidor confirma el guardado.
 * Las fotografías se conservan en memoria mientras la página esté abierta;
 * las que no se enviaron se pierden al recargar o cerrar la pestaña.
 */
(function () {
  'use strict';

  // Extensiones de imagen aceptadas cuando el navegador no informa el tipo MIME
  // (ocurre con algunos selectores de archivos en Android).
  const EXTENSIONES_IMAGEN = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i;

  // Lado mayor (en píxeles) de las miniaturas de la galería. Usar miniaturas
  // en lugar de las fotos originales evita que el teléfono se quede sin
  // memoria (iOS puede recargar la pestaña y se perderían las fotos).
  const LADO_MINIATURA = 480;

  // ---- Envío al servidor (Google Apps Script) ----
  // La configuración es pública (config.js): no contiene contraseñas.
  const CONFIG = window.BODA_CONFIG || {};
  const URL_SERVIDOR = CONFIG.urlServidor || '';
  const CLAVE_EVENTO = CONFIG.claveEvento || '';
  const SERVICIO = CONFIG.servicio || 'hector-martha-pruebas';
  const PATRON_URL_SERVIDOR = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[A-Za-z0-9_-]+\/exec$/;

  // Optimización antes de enviar (misma que se probó en Mac y iPhone).
  const LADO_MAXIMO = 2560;
  const CALIDAD = 0.85;
  const LADO_REDUCIDO = 2048;
  const CALIDAD_REDUCIDA = 0.75;
  const LIMITE_OPTIMIZADA = 4 * 1024 * 1024; // si se supera, se reduce más
  const LIMITE_SERVIDOR = 8 * 1024 * 1024;   // el servidor no acepta más de 8 MB

  // Red: tiempo máximo por intento y esperas entre reintentos automáticos.
  const TIEMPO_LIMITE_MS = 60000;
  const ESPERAS_REINTENTO_MS = [2000, 5000, 10000];

  // Respuestas temporales del servidor: se reintenta solo, con el mismo id.
  const CODIGOS_TEMPORALES = ['ocupado', 'en-proceso', 'limite-minuto', 'error-guardado', 'verificacion-fallida', 'error-interno'];
  // Rechazos definitivos: reintentar no cambiaría el resultado.
  const CODIGOS_DEFINITIVOS = ['formato-no-permitido', 'archivo-muy-grande', 'archivo-vacio', 'peticion-invalida'];

  const el = {
    btnTomar: document.getElementById('btn-tomar'),
    btnSeleccionar: document.getElementById('btn-seleccionar'),
    btnRepetir: document.getElementById('btn-repetir'),
    btnCancelar: document.getElementById('btn-cancelar'),
    btnConfirmar: document.getElementById('btn-confirmar'),
    btnOtra: document.getElementById('btn-otra'),
    btnReintentarSubida: document.getElementById('btn-reintentar-subida'),
    btnReintentarPendientes: document.getElementById('btn-reintentar-pendientes'),
    seccionConfirmacion: document.getElementById('seccion-confirmacion'),
    tituloConfirmacion: document.getElementById('titulo-confirmacion'),
    textoConfirmacion: document.getElementById('texto-confirmacion'),
    inputCamara: document.getElementById('input-camara'),
    inputGaleria: document.getElementById('input-galeria'),
    seccionCaptura: document.getElementById('seccion-captura'),
    seccionPrevia: document.getElementById('seccion-vista-previa'),
    imagen: document.getElementById('imagen-previa'),
    info: document.getElementById('info-archivo'),
    mensaje: document.getElementById('mensaje'),
    // Galería
    btnsVerGaleria: document.querySelectorAll('.btn-ver-galeria'),
    btnVolverInicio: document.getElementById('btn-volver-inicio'),
    seccionGaleria: document.getElementById('seccion-galeria'),
    tituloGaleria: document.getElementById('titulo-galeria'),
    galeriaVacia: document.getElementById('galeria-vacia'),
    miGaleriaAviso: document.getElementById('mi-galeria-aviso'),
    btnLimpiarMiGaleria: document.getElementById('btn-limpiar-mi-galeria'),
    cuadricula: document.getElementById('galeria-cuadricula'),
    // Pestañas y galería compartida
    pestanaCompartida: document.getElementById('pestana-compartida'),
    pestanaMia: document.getElementById('pestana-mia'),
    panelCompartida: document.getElementById('panel-compartida'),
    panelMia: document.getElementById('panel-mia'),
    compartidaEstado: document.getElementById('compartida-estado'),
    compartidaCuadricula: document.getElementById('compartida-cuadricula'),
    btnCargarMas: document.getElementById('btn-cargar-mas'),
    btnActualizarGaleria: document.getElementById('btn-actualizar-galeria'),
    // Visor
    visor: document.getElementById('visor'),
    visorImagen: document.getElementById('visor-imagen'),
    visorContador: document.getElementById('visor-contador'),
    visorAnterior: document.getElementById('visor-anterior'),
    visorSiguiente: document.getElementById('visor-siguiente'),
    visorCerrar: document.getElementById('visor-cerrar'),
    visorGuardar: document.getElementById('visor-guardar'),
    // Cuadro de diálogo
    dialogo: document.getElementById('dialogo'),
    dialogoIcono: document.getElementById('dialogo-icono'),
    dialogoTitulo: document.getElementById('dialogo-titulo'),
    dialogoTexto: document.getElementById('dialogo-texto'),
    dialogoAviso: document.getElementById('dialogo-aviso'),
    dialogoAceptar: document.getElementById('dialogo-aceptar'),
    dialogoCancelar: document.getElementById('dialogo-cancelar'),
    // Cámara integrada
    camara: document.getElementById('camara'),
    camaraVideo: document.getElementById('camara-video'),
    camaraFlash: document.getElementById('camara-flash'),
    camaraCerrar: document.getElementById('camara-cerrar'),
    camaraCargando: document.getElementById('camara-cargando'),
    camaraError: document.getElementById('camara-error'),
    camaraErrorTitulo: document.getElementById('camara-error-titulo'),
    camaraErrorTexto: document.getElementById('camara-error-texto'),
    camaraUsarNativa: document.getElementById('camara-usar-nativa'),
    camaraReintentar: document.getElementById('camara-reintentar'),
    camaraErrorCerrar: document.getElementById('camara-error-cerrar'),
    camaraGaleria: document.getElementById('camara-galeria'),
    camaraDisparador: document.getElementById('camara-disparador'),
    camaraCambiar: document.getElementById('camara-cambiar')
  };

  // Estado de la cámara integrada.
  const camara = {
    abierta: false,
    stream: null,          // MediaStream activo
    modo: 'environment',   // 'environment' = trasera, 'user' = frontal
    espejo: false,         // la cámara frontal se muestra como un espejo
    capturando: false,
    solicitud: 0,          // descarta respuestas tardías de getUserMedia
    pausadaEnSegundoPlano: false
  };

  // Estado de la selección actual.
  const estado = {
    archivo: null,   // File seleccionado
    urlPrevia: null, // URL local (blob:) usada en la vista previa
    origen: null     // 'camara' | 'galeria' — se usa para "Repetir"
  };

  // Fotografías confirmadas por el invitado. Cada elemento:
  //   { id, archivo, origen, confirmadaEn, url, miniaturaUrl,
  //     idSubida, estadoSubida, mensajeSubida, intentoSubida, reintentable, jpeg }
  //   - url: referencia local (blob:) a la foto original, para el visor.
  //   - miniaturaUrl: referencia local a una copia pequeña, para la cuadrícula.
  //   - idSubida: id aleatorio y ESTABLE (32 caracteres) que se envía en cada
  //     intento; el servidor lo usa para no guardar la misma foto dos veces.
  //   - estadoSubida: 'en-espera' | 'preparando' | 'subiendo' | 'guardada' |
  //     'sin-confirmar' | 'desactivadas' | 'rechazada'.
  //   - jpeg: { blob, ancho, alto } optimizado; se conserva para reintentar.
  // Es una lista para no perder una foto si el invitado elige otra mientras
  // la anterior todavía se está enviando.
  const fotosConfirmadas = [];

  // Foto cuyo estado se muestra en la pantalla de confirmación.
  let fotoActual = null;

  // Cola de envíos: se suben de una en una (menos memoria en el teléfono).
  const colaSubidas = [];
  let procesandoCola = false;

  // Índice de la foto abierta en el visor (-1 = cerrado) y botón que lo abrió.
  let indiceVisor = -1;
  let botonQueAbrioVisor = null;
  // El visor muestra fotos de «Mi galería» ('local') o de la galería
  // compartida ('compartida'); en este caso se identifica la foto por su
  // referencia pública, para que las fotos nuevas no cambien la que se ve.
  let fuenteVisor = 'local';
  let refVisor = null;

  /* ---------- Utilidades ---------- */

  function esImagen(archivo) {
    if (archivo.type) {
      return archivo.type.indexOf('image/') === 0;
    }
    return EXTENSIONES_IMAGEN.test(archivo.name || '');
  }

  function esHeic(archivo) {
    return /image\/hei[cf]/i.test(archivo.type) || /\.hei[cf]$/i.test(archivo.name || '');
  }

  function formatearTamano(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function mostrarMensaje(texto, tipo) {
    el.mensaje.textContent = texto;
    el.mensaje.className = 'mensaje' + (tipo ? ' mensaje-' + tipo : '');
    el.mensaje.hidden = false;
  }

  function ocultarMensaje() {
    el.mensaje.hidden = true;
    el.mensaje.textContent = '';
  }

  function liberarUrlPrevia() {
    if (estado.urlPrevia) {
      URL.revokeObjectURL(estado.urlPrevia);
      estado.urlPrevia = null;
    }
  }

  // Crea una copia pequeña (JPEG) de la foto para la cuadrícula.
  // Si se recibe la imagen de la vista previa ya cargada, se reutiliza para
  // no decodificar la foto otra vez. Devuelve { url, blob } o null
  // (el blob se guarda en «Mi galería» para recuperarla al volver).
  function crearMiniatura(archivo, imagenCargada) {
    return new Promise(function (resolve) {
      function dibujar(img) {
        try {
          const ancho = img.naturalWidth;
          const alto = img.naturalHeight;
          if (!ancho || !alto) return resolve(null);
          const escala = Math.min(1, LADO_MINIATURA / Math.max(ancho, alto));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(ancho * escala);
          canvas.height = Math.round(alto * escala);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            resolve(blob ? { url: URL.createObjectURL(blob), blob: blob } : null);
          }, 'image/jpeg', 0.8);
        } catch (e) {
          resolve(null);
        }
      }

      if (imagenCargada && imagenCargada.complete && imagenCargada.naturalWidth) {
        dibujar(imagenCargada);
        return;
      }
      const url = URL.createObjectURL(archivo);
      const img = new Image();
      img.onload = function () {
        dibujar(img);
        URL.revokeObjectURL(url);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  // «Ver galería» abre la galería (compartida y local); la cantidad de fotos
  // de este dispositivo se muestra en la pestaña «Mi galería».
  function actualizarBotonesGaleria() {
    const total = fotosConfirmadas.length;
    el.btnsVerGaleria.forEach(function (boton) {
      boton.textContent = 'Ver galería';
    });
    el.pestanaMia.textContent = total > 0 ? 'Mi galería (' + total + ')' : 'Mi galería';
    actualizarBotonLimpiar();
  }

  // «Limpiar mi galería» solo se ve en la pestaña «Mi galería» y si tiene fotos.
  function actualizarBotonLimpiar() {
    el.btnLimpiarMiGaleria.hidden = pestanaGaleria !== 'mia' || fotosConfirmadas.length === 0;
  }

  /* ---------- Flujo principal ---------- */

  // Abre la cámara o la galería. Debe llamarse dentro de un evento de clic
  // del usuario; de lo contrario iOS y Android bloquean la apertura.
  function abrirSelector(origen) {
    const input = origen === 'camara' ? el.inputCamara : el.inputGaleria;
    // Limpiar el valor permite volver a elegir el mismo archivo y que
    // el evento "change" se dispare de nuevo.
    input.value = '';
    input.click();
  }

  function manejarSeleccion(evento, origen) {
    const input = evento.target;
    const archivo = input.files && input.files[0];

    // Si el usuario cerró la cámara o el selector sin elegir nada,
    // no hay archivo: se conserva lo que hubiera antes.
    if (!archivo) return;

    if (!esImagen(archivo)) {
      mostrarMensaje('El archivo seleccionado no es una imagen. Elige una fotografía.', 'error');
      input.value = '';
      return;
    }

    mostrarVistaPrevia(archivo, origen);
  }

  function mostrarVistaPrevia(archivo, origen) {
    liberarUrlPrevia();
    ocultarMensaje();

    estado.archivo = archivo;
    estado.origen = origen;
    estado.urlPrevia = URL.createObjectURL(archivo);

    el.imagen.onerror = function () {
      // Por ejemplo: fotos HEIC en navegadores que no las soportan (Chrome).
      const texto = esHeic(archivo)
        ? 'Este navegador no puede mostrar fotografías en formato HEIC. Prueba con otra fotografía o con otro navegador.'
        : 'No se pudo mostrar la vista previa de esta imagen. Prueba con otra fotografía.';
      reiniciar();
      mostrarMensaje(texto, 'error');
    };
    el.imagen.src = estado.urlPrevia;

    el.info.textContent = (archivo.name || 'Fotografía') + ' · ' + formatearTamano(archivo.size);

    el.btnConfirmar.disabled = false;
    el.seccionConfirmacion.hidden = true;
    el.seccionCaptura.hidden = true;
    el.seccionPrevia.hidden = false;
  }

  // "Sí, compartir fotografía": SOLO aquí empieza el envío al servidor.
  // La foto queda en memoria y se pone en la cola de subida; la pantalla de
  // confirmación muestra su estado real (nunca un éxito antes de tiempo).
  function confirmarFotografia() {
    const archivo = estado.archivo;
    if (!archivo) return;

    // Evita duplicados por doble toque.
    el.btnConfirmar.disabled = true;
    let foto = null;
    fotosConfirmadas.forEach(function (f) {
      if (f.archivo === archivo) foto = f;
    });
    if (!foto) {
      foto = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        archivo: archivo,
        origen: estado.origen,
        confirmadaEn: new Date(),
        url: URL.createObjectURL(archivo),
        miniaturaUrl: null,
        idSubida: nuevoIdSubida(),
        estadoSubida: 'en-espera',
        mensajeSubida: '',
        intentoSubida: 0,
        reintentable: true,
        jpeg: null
      };
      fotosConfirmadas.push(foto);

      // La miniatura se genera aparte; mientras tanto la galería usa la original.
      const nuevaFoto = foto;
      crearMiniatura(archivo, el.imagen).then(function (miniatura) {
        if (!miniatura) return;
        nuevaFoto.miniaturaUrl = miniatura.url;
        nuevaFoto.miniaturaBlob = miniatura.blob;
        const img = el.cuadricula.querySelector('img[data-id="' + nuevaFoto.id + '"]');
        if (img) img.src = miniatura.url;
        guardarEnMiGaleria(nuevaFoto); // ahora también con su miniatura
      });

      // Se guarda en este teléfono para no perderla al recargar o cerrar la página.
      guardarEnMiGaleria(foto);
      encolarSubida(foto);
    }
    fotoActual = foto;
    actualizarBotonesGaleria();

    // Libera la vista previa; el archivo sigue disponible en fotosConfirmadas.
    reiniciar();
    ocultarMensaje();

    mostrarEstadoConfirmacion(foto);

    el.seccionCaptura.hidden = true;
    el.seccionConfirmacion.hidden = false;

    // En el teléfono la vista previa pudo quedar desplazada hacia abajo.
    window.scrollTo(0, 0);
    el.tituloConfirmacion.focus({ preventScroll: true });
  }

  // Vuelve a la pantalla inicial para elegir otra fotografía,
  // conservando las ya confirmadas.
  function elegirOtra() {
    el.seccionConfirmacion.hidden = true;
    el.seccionCaptura.hidden = false;
  }

  // Descarta la selección actual y vuelve a la pantalla inicial.
  function reiniciar() {
    liberarUrlPrevia();
    estado.archivo = null;
    estado.origen = null;

    el.imagen.onerror = null;
    el.imagen.removeAttribute('src');
    el.info.textContent = '';
    el.inputCamara.value = '';
    el.inputGaleria.value = '';

    el.seccionPrevia.hidden = true;
    el.seccionCaptura.hidden = false;
  }

  /* ---------- Galería temporal ---------- */

  // Se usa el historial del navegador para que el botón "atrás" de Android
  // (o el gesto de volver en iPhone) cierre el visor o la galería en lugar
  // de salir de la página, lo que borraría las fotografías de la memoria.

  function mostrarInicioUI() {
    detenerActualizacion();
    el.seccionGaleria.hidden = true;
    el.seccionConfirmacion.hidden = true;
    el.seccionPrevia.hidden = true;
    el.seccionCaptura.hidden = false;
    window.scrollTo(0, 0);
  }

  function renderizarGaleria() {
    el.cuadricula.textContent = '';
    const total = fotosConfirmadas.length;
    el.galeriaVacia.hidden = total > 0;
    el.cuadricula.hidden = total === 0;

    const fragmento = document.createDocumentFragment();
    fotosConfirmadas.forEach(function (foto, indice) {
      const item = document.createElement('li');
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'galeria-miniatura';
      boton.setAttribute('data-id', foto.id);
      boton.addEventListener('click', function () {
        abrirVisor(indice, boton);
      });

      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.setAttribute('data-id', foto.id);
      img.src = foto.miniaturaUrl || foto.url;

      // Distintivo: «Compartida» solo si el servidor confirmó el guardado.
      const distintivo = document.createElement('span');
      distintivo.setAttribute('aria-hidden', 'true');

      boton.appendChild(img);
      boton.appendChild(distintivo);
      actualizarMiniatura(foto, boton, indice, total);
      item.appendChild(boton);
      fragmento.appendChild(item);
    });
    el.cuadricula.appendChild(fragmento);
    actualizarBotonReintentarPendientes();
  }

  function mostrarGaleriaUI() {
    ocultarMensaje();
    renderizarGaleria();
    el.seccionCaptura.hidden = true;
    el.seccionConfirmacion.hidden = true;
    el.seccionPrevia.hidden = true;
    el.seccionGaleria.hidden = false;
    mostrarPestana(pestanaGaleria); // inicia o reanuda la galería compartida si corresponde
    window.scrollTo(0, 0);
    el.tituloGaleria.focus({ preventScroll: true });
  }

  function abrirGaleria() {
    mostrarGaleriaUI();
    history.pushState({ pantalla: 'galeria' }, '');
  }

  function volverAlInicio() {
    if (history.state && history.state.pantalla === 'galeria') {
      history.back(); // el evento popstate muestra el inicio
    } else {
      mostrarInicioUI();
    }
  }

  function mostrarFotoEnVisor(indice) {
    const total = fotosConfirmadas.length;
    const foto = fotosConfirmadas[indice];
    indiceVisor = indice;
    el.visorImagen.src = foto.urlGrande || foto.url;
    el.visorImagen.alt = 'Fotografía ' + (indice + 1) + ' de ' + total;
    el.visorContador.textContent = (indice + 1) + ' de ' + total + ' · ' + etiquetaEstado(foto).texto;
    el.visorAnterior.disabled = indice === 0;
    el.visorSiguiente.disabled = indice === total - 1;
    // Foto compartida recuperada de una visita anterior: en el teléfono solo
    // queda su miniatura; la foto completa se pide al servidor.
    if (!foto.archivo && !foto.jpeg && !foto.urlGrande && foto.estadoSubida === 'guardada' && foto.referencia) {
      cargarGrandeMiGaleria(foto, indice);
    }
  }

  async function cargarGrandeMiGaleria(foto, indice) {
    if (foto.cargandoGrande) return;
    foto.cargandoGrande = true;
    const base = el.visorContador.textContent;
    el.visorContador.textContent = base + ' · Cargando…';
    const r = await consultarGaleria({ accion: 'foto', ref: foto.referencia }, TIEMPO_FOTO_MS);
    foto.cargandoGrande = false;
    if (r.respondio && r.json.ok && r.json.ref === foto.referencia &&
        r.json.tipo === 'image/jpeg' && typeof r.json.datos === 'string') {
      foto.urlGrande = URL.createObjectURL(blobDesdeBase64(r.json.datos, 'image/jpeg'));
    }
    // El invitado pudo cambiar de foto o cerrar el visor mientras tanto.
    if (fuenteVisor !== 'local' || el.visor.hidden || fotosConfirmadas[indiceVisor] !== foto) return;
    if (foto.urlGrande) {
      el.visorImagen.src = foto.urlGrande;
      el.visorContador.textContent = base;
    } else {
      el.visorContador.textContent = base + ' · Se muestra en tamaño reducido';
    }
  }

  function mostrarVisorUI(indice) {
    fuenteVisor = 'local';
    refVisor = null;
    el.visorGuardar.hidden = true; // «Guardar» es solo para la galería compartida
    mostrarFotoEnVisor(indice);
    el.visor.hidden = false;
    document.body.classList.add('visor-abierto');
    el.visorCerrar.focus();
  }

  function cerrarVisorUI() {
    if (el.visor.hidden) return;
    el.visor.hidden = true;
    // Quitar la imagen libera la memoria de la foto en tamaño completo.
    el.visorImagen.removeAttribute('src');
    indiceVisor = -1;
    fuenteVisor = 'local';
    refVisor = null;
    compartida.tokenVisor++; // descarta descargas de fotos grandes que sigan en curso
    // Las fotos completas pedidas al servidor para «Mi galería» se liberan al cerrar.
    fotosConfirmadas.forEach(function (foto) {
      if (foto.urlGrande) {
        URL.revokeObjectURL(foto.urlGrande);
        foto.urlGrande = null;
      }
    });
    document.body.classList.remove('visor-abierto');
    if (botonQueAbrioVisor && document.body.contains(botonQueAbrioVisor)) {
      botonQueAbrioVisor.focus();
    }
    botonQueAbrioVisor = null;
  }

  function abrirVisor(indice, boton) {
    botonQueAbrioVisor = boton || null;
    fuenteVisor = 'local';
    mostrarVisorUI(indice);
    history.pushState({ pantalla: 'visor', indice: indice }, '');
  }

  function cerrarVisor() {
    if (history.state && history.state.pantalla === 'visor') {
      history.back(); // el evento popstate cierra el visor
    } else {
      cerrarVisorUI();
    }
  }

  function moverVisor(paso) {
    if (fuenteVisor === 'compartida') {
      moverVisorCompartida(paso);
      return;
    }
    const nuevo = indiceVisor + paso;
    if (indiceVisor < 0 || nuevo < 0 || nuevo >= fotosConfirmadas.length) return;
    mostrarFotoEnVisor(nuevo);
    if (history.state && history.state.pantalla === 'visor') {
      history.replaceState({ pantalla: 'visor', indice: nuevo }, '');
    }
  }

  /* ---------- Galería compartida (fotos guardadas en Google Drive) ---------- */

  // Las fotos se piden a Apps Script (accion=lista | miniaturas | foto) y
  // llegan en base64 dentro del JSON: la carpeta de Drive sigue privada y
  // nunca se usan enlaces de Drive en <img>. Las respuestas solo traen
  // referencias públicas opacas, nunca IDs de Drive.

  const PAGINA_COMPARTIDA = 24;
  const LOTE_MINIATURAS = 12;              // máximo del servidor; las miniaturas ya llegan reducidas (~480 px)
  const LADO_MINIATURA_COMPARTIDA = 480;   // solo se reducen en el teléfono si llegan más grandes
  const MAX_FOTOS_GRANDES_EN_MEMORIA = 6;  // fotos grandes guardadas para volver a verlas
  // Cada 30 s mientras la galería compartida está a la vista. Si no hay
  // fotos nuevas, el servidor responde «sinCambios» (unos pocos bytes).
  const INTERVALO_ACTUALIZACION_MS = 30000;
  const DURACION_AVISO_NUEVAS_MS = 5000;
  const TIEMPO_LISTA_MS = 30000;
  const TIEMPO_MINIATURAS_MS = 45000;
  const TIEMPO_FOTO_MS = 60000;
  const PATRON_REF_PUBLICA = /^[0-9a-f]{12}(?:-[0-9a-f]{4})?$/;
  const TIPOS_IMAGEN = /^image\/(jpeg|png)$/;

  let pestanaGaleria = 'compartida';

  const compartida = {
    orden: [],          // referencias, de la más reciente a la más antigua (sin repetir)
    datos: {},          // ref → { ref, fecha, estadoMin, miniaturaUrl, fotoUrl, elemento }
    version: null,
    total: 0,
    siguiente: null,    // cursor para «Cargar más»
    cargada: false,
    cargando: false,
    desactualizada: false,
    ultimaConsulta: 0,
    temporizador: null,
    observador: null,
    colaMiniaturas: [],
    cargandoMiniaturas: false,
    esperaLote: null,
    avisoNuevas: null,
    fotosGrandes: [],   // refs con foto grande en memoria (las más antiguas se liberan)
    tokenVisor: 0
  };

  // -- Comunicación (GET simple, sin cookies; el mismo mecanismo ya probado) --

  async function consultarGaleria(parametros, tiempoMs) {
    if (!PATRON_URL_SERVIDOR.test(URL_SERVIDOR)) return { respondio: false, motivo: 'sin-configuracion' };
    const consulta = Object.keys(parametros).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(parametros[k]);
    }).join('&');
    const url = URL_SERVIDOR + '?' + consulta + '&clave=' + encodeURIComponent(CLAVE_EVENTO);
    const controlador = new AbortController();
    const limite = setTimeout(function () { controlador.abort(); }, tiempoMs);
    try {
      const respuesta = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
        signal: controlador.signal
      });
      const texto = await respuesta.text();
      let json = null;
      try { json = JSON.parse(texto); } catch (e) { json = null; }
      if (!json || typeof json !== 'object' || json.servicio !== SERVICIO) {
        return { respondio: false, motivo: 'respuesta-no-valida' };
      }
      return { respondio: true, json: json };
    } catch (error) {
      return { respondio: false, motivo: error && error.name === 'AbortError' ? 'tiempo-agotado' : 'red' };
    } finally {
      clearTimeout(limite);
    }
  }

  function blobDesdeBase64(datos, tipo) {
    const binario = atob(datos);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    return new Blob([bytes], { type: tipo });
  }

  // El servidor ya entrega miniaturas de ~480 px: se usan tal cual. Solo si
  // alguna llega más grande (respaldo de Drive) se reduce en el teléfono.
  async function miniaturaReducida(blob) {
    let carga = null;
    try {
      carga = await cargarImagen(blob);
      if (Math.max(carga.img.naturalWidth, carga.img.naturalHeight) <= LADO_MINIATURA_COMPARTIDA * 1.25) {
        const url = carga.url;
        carga = null; // se conserva: es la URL de la miniatura
        return url;
      }
      const reducida = await aJpeg(carga.img, LADO_MINIATURA_COMPARTIDA, 0.8);
      return reducida ? URL.createObjectURL(reducida.blob) : null;
    } catch (e) {
      return null;
    } finally {
      if (carga) URL.revokeObjectURL(carga.url);
    }
  }

  // -- Estado visible --

  function mostrarEstadoCompartida(texto, tipo) {
    if (!texto) {
      el.compartidaEstado.hidden = true;
      el.compartidaEstado.textContent = '';
      return;
    }
    el.compartidaEstado.textContent = texto;
    el.compartidaEstado.className = 'mensaje' + (tipo ? ' mensaje-' + tipo : '');
    el.compartidaEstado.hidden = false;
  }

  function actualizarControlesCompartida() {
    el.btnCargarMas.hidden = !compartida.siguiente;
    el.btnCargarMas.disabled = compartida.cargando;
    el.btnActualizarGaleria.disabled = compartida.cargando;
    el.btnActualizarGaleria.textContent = compartida.cargando ? 'Actualizando…' : 'Actualizar galería';
    el.compartidaCuadricula.hidden = compartida.orden.length === 0;
  }

  function textoErrorLista(r) {
    if (!r.respondio) {
      return r.motivo === 'sin-configuracion'
        ? 'La aplicación todavía no está configurada para mostrar la galería.'
        : 'No pudimos cargar la galería. Revisa tu conexión y pulsa «Actualizar galería».';
    }
    if (r.json.codigo === 'clave-invalida') return 'La galería compartida no está disponible en este momento.';
    if (r.json.ok && !Array.isArray(r.json.fotos)) return 'La galería compartida todavía no está activada en el servidor.';
    return typeof r.json.mensaje === 'string' && r.json.mensaje ? r.json.mensaje : 'No pudimos cargar la galería.';
  }

  function fotoLocalDe(ref) {
    let encontrada = null;
    fotosConfirmadas.forEach(function (f) {
      if (f.referencia === ref && f.estadoSubida === 'guardada') encontrada = f;
    });
    return encontrada;
  }

  // -- Lista de fotos --

  // Agrega fotos sin repetir. posicion: 'inicio' (nuevas) o 'final' (más antiguas).
  function agregarFotosCompartidas(fotos, posicion) {
    const agregadas = [];
    fotos.forEach(function (f) {
      if (!f || !PATRON_REF_PUBLICA.test(f.ref) || compartida.orden.indexOf(f.ref) !== -1 || agregadas.indexOf(f.ref) !== -1) return;
      if (!compartida.datos[f.ref]) {
        compartida.datos[f.ref] = { ref: f.ref, fecha: f.fecha, estadoMin: 'pendiente', miniaturaUrl: null, fotoUrl: null, elemento: null };
      }
      agregadas.push(f.ref);
    });
    compartida.orden = posicion === 'inicio' ? agregadas.concat(compartida.orden) : compartida.orden.concat(agregadas);
    return agregadas;
  }

  // Primera carga y «Actualizar galería»: vuelve a pedir la primera página.
  // Las miniaturas ya descargadas se reutilizan.
  async function cargarGaleriaCompartida() {
    if (compartida.cargando) return;
    compartida.cargando = true;
    actualizarControlesCompartida();
    if (!compartida.cargada) mostrarEstadoCompartida('Cargando fotografías…', '');

    const r = await consultarGaleria({ accion: 'lista', limite: String(PAGINA_COMPARTIDA) }, TIEMPO_LISTA_MS);
    compartida.cargando = false;
    compartida.ultimaConsulta = Date.now();

    if (!r.respondio || !r.json.ok || !Array.isArray(r.json.fotos)) {
      mostrarEstadoCompartida(textoErrorLista(r), 'error');
      actualizarControlesCompartida();
      return;
    }

    // Las miniaturas que fallaron se vuelven a intentar.
    Object.keys(compartida.datos).forEach(function (ref) {
      if (compartida.datos[ref].estadoMin === 'error') compartida.datos[ref].estadoMin = 'pendiente';
    });
    compartida.orden = [];
    agregarFotosCompartidas(r.json.fotos, 'final');
    compartida.version = r.json.version;
    compartida.total = r.json.total;
    compartida.siguiente = r.json.siguiente || null;
    compartida.cargada = true;
    compartida.desactualizada = false;

    el.compartidaCuadricula.textContent = '';
    compartida.orden.forEach(function (ref) {
      el.compartidaCuadricula.appendChild(elementoCompartido(ref, true));
    });
    mostrarEstadoCompartida(compartida.orden.length === 0
      ? 'Todavía no hay fotografías compartidas. ¡Sé la primera persona en compartir una!'
      : '', '');
    actualizarControlesCompartida();
  }

  // Consulta periódica: si nada cambió, el servidor responde «sinCambios»
  // (unos pocos bytes). Las fotos nuevas se agregan arriba sin repetir.
  async function buscarFotosNuevas() {
    if (compartida.cargando) return;
    if (!compartida.cargada) {
      await cargarGaleriaCompartida();
      return;
    }
    compartida.cargando = true;
    const r = await consultarGaleria({
      accion: 'lista',
      limite: String(PAGINA_COMPARTIDA),
      version: compartida.version || ''
    }, TIEMPO_LISTA_MS);
    compartida.cargando = false;
    compartida.ultimaConsulta = Date.now();
    actualizarControlesCompartida();
    if (!r.respondio || !r.json.ok) return; // silencioso: se reintenta en la próxima consulta
    compartida.desactualizada = false;
    if (r.json.sinCambios) {
      compartida.total = r.json.total;
      return;
    }
    if (!Array.isArray(r.json.fotos)) return;

    const nuevas = agregarFotosCompartidas(r.json.fotos, 'inicio');
    compartida.version = r.json.version;
    compartida.total = r.json.total;
    for (let i = nuevas.length - 1; i >= 0; i--) {
      el.compartidaCuadricula.insertBefore(elementoCompartido(nuevas[i], true), el.compartidaCuadricula.firstChild);
    }
    if (nuevas.length > 0) {
      avisarFotosNuevas(nuevas.length);
    } else if (compartida.orden.length > 0 && !compartida.avisoNuevas) {
      mostrarEstadoCompartida('', '');
    }
    actualizarControlesCompartida();
  }

  // Aviso breve (5 s) cuando llegan fotos nuevas solas, sin mover la página.
  function avisarFotosNuevas(cantidad) {
    mostrarEstadoCompartida(cantidad === 1
      ? 'Llegó 1 fotografía nueva.'
      : 'Llegaron ' + cantidad + ' fotografías nuevas.', 'exito');
    if (compartida.avisoNuevas) clearTimeout(compartida.avisoNuevas);
    compartida.avisoNuevas = setTimeout(function () {
      compartida.avisoNuevas = null;
      if (el.compartidaEstado.classList.contains('mensaje-exito')) mostrarEstadoCompartida('', '');
    }, DURACION_AVISO_NUEVAS_MS);
  }

  async function cargarMasCompartidas() {
    if (compartida.cargando || !compartida.siguiente) return;
    compartida.cargando = true;
    actualizarControlesCompartida();
    const r = await consultarGaleria({
      accion: 'lista',
      limite: String(PAGINA_COMPARTIDA),
      antes: compartida.siguiente
    }, TIEMPO_LISTA_MS);
    compartida.cargando = false;
    if (!r.respondio || !r.json.ok || !Array.isArray(r.json.fotos)) {
      mostrarEstadoCompartida('No se pudieron cargar más fotografías. Inténtalo de nuevo.', 'error');
      actualizarControlesCompartida();
      return;
    }
    const agregadas = agregarFotosCompartidas(r.json.fotos, 'final');
    compartida.siguiente = r.json.siguiente || null;
    compartida.total = r.json.total;
    agregadas.forEach(function (ref) {
      el.compartidaCuadricula.appendChild(elementoCompartido(ref, true));
    });
    mostrarEstadoCompartida('', '');
    actualizarControlesCompartida();
  }

  // -- Cuadrícula --

  // Crea (o reutiliza) el elemento de una foto. Las nuevas aparecen con una
  // animación suave; las que ya existían no se vuelven a animar.
  function elementoCompartido(ref, nuevo) {
    const d = compartida.datos[ref];
    if (d.elemento) {
      d.elemento.classList.remove('nuevo');
      pintarMiniatura(ref);
      // Una miniatura que falló se vuelve a pedir cuando quede a la vista.
      if (d.estadoMin === 'pendiente') {
        if (compartida.observador) compartida.observador.observe(d.elemento.firstChild);
        else pedirMiniatura(ref);
      }
      return d.elemento;
    }
    const item = document.createElement('li');
    if (nuevo) {
      item.className = 'nuevo';
      item.addEventListener('animationend', function () { item.classList.remove('nuevo'); }, { once: true });
    }
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'galeria-miniatura';
    boton.setAttribute('data-ref', ref);
    boton.addEventListener('click', function () {
      abrirVisorCompartida(ref, boton);
    });
    item.appendChild(boton);
    d.elemento = item;
    pintarMiniatura(ref);

    if (compartida.observador) {
      compartida.observador.observe(boton);
    } else {
      pedirMiniatura(ref);
    }
    return item;
  }

  function pintarMiniatura(ref) {
    const d = compartida.datos[ref];
    if (!d || !d.elemento) return;
    const boton = d.elemento.firstChild;
    const local = fotoLocalDe(ref);
    boton.setAttribute('aria-label', 'Ver fotografía compartida' + (local ? ' (tuya)' : ''));
    boton.textContent = '';

    if (d.miniaturaUrl) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.src = d.miniaturaUrl;
      boton.appendChild(img);
    } else {
      const marcador = document.createElement('span');
      marcador.setAttribute('aria-hidden', 'true');
      if (d.estadoMin === 'error') {
        marcador.className = 'compartida-marcador sin-imagen';
        marcador.textContent = 'Toca para verla';
      } else {
        marcador.className = 'compartida-marcador';
      }
      boton.appendChild(marcador);
    }

    if (local) {
      const distintivo = document.createElement('span');
      distintivo.className = 'galeria-estado galeria-estado-guardada';
      distintivo.setAttribute('aria-hidden', 'true');
      distintivo.textContent = 'Tuya';
      boton.appendChild(distintivo);
    }
  }

  // -- Miniaturas: solo las visibles, en lotes pequeños y de una petición a la vez --

  function pedirMiniatura(ref) {
    const d = compartida.datos[ref];
    if (!d || d.estadoMin !== 'pendiente') return;
    d.estadoMin = 'en-cola';
    compartida.colaMiniaturas.push(ref);
    // Espera un instante para juntar en un solo lote todas las fotos que
    // aparecen a la vez en pantalla (hasta 12 por petición).
    if (!compartida.esperaLote) {
      compartida.esperaLote = setTimeout(function () {
        compartida.esperaLote = null;
        procesarMiniaturas();
      }, 60);
    }
  }

  async function procesarMiniaturas() {
    if (compartida.cargandoMiniaturas) return;
    compartida.cargandoMiniaturas = true;
    try {
      while (compartida.colaMiniaturas.length > 0) {
        const lote = compartida.colaMiniaturas.splice(0, LOTE_MINIATURAS);
        const r = await consultarGaleria({ accion: 'miniaturas', refs: lote.join(',') }, TIEMPO_MINIATURAS_MS);
        const recibidas = {};
        if (r.respondio && r.json.ok && Array.isArray(r.json.miniaturas)) {
          r.json.miniaturas.forEach(function (m) { if (m && m.ref) recibidas[m.ref] = m; });
        }
        for (let i = 0; i < lote.length; i++) {
          const ref = lote[i];
          const d = compartida.datos[ref];
          const m = recibidas[ref];
          if (m && typeof m.datos === 'string' && TIPOS_IMAGEN.test(m.tipo)) {
            const url = await miniaturaReducida(blobDesdeBase64(m.datos, m.tipo));
            d.miniaturaUrl = url;
            d.estadoMin = url ? 'lista' : 'error';
          } else {
            d.estadoMin = 'error';
          }
          pintarMiniatura(ref);
        }
      }
    } finally {
      compartida.cargandoMiniaturas = false;
    }
  }

  if ('IntersectionObserver' in window) {
    compartida.observador = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (entrada) {
        if (!entrada.isIntersecting) return;
        compartida.observador.unobserve(entrada.target);
        pedirMiniatura(entrada.target.getAttribute('data-ref'));
      });
    }, { rootMargin: '300px 0px' });
  }

  // -- Visor de fotos compartidas (foto grande solo al abrirla) --

  function abrirVisorCompartida(ref, boton) {
    botonQueAbrioVisor = boton || null;
    mostrarVisorCompartidaUI(ref);
    history.pushState({ pantalla: 'visor', fuente: 'compartida', ref: ref }, '');
  }

  function mostrarVisorCompartidaUI(ref) {
    fuenteVisor = 'compartida';
    mostrarCompartidaEnVisor(ref);
    el.visor.hidden = false;
    document.body.classList.add('visor-abierto');
    el.visorCerrar.focus();
  }

  function textoContadorCompartida(ref) {
    const posicion = compartida.orden.indexOf(ref) + 1;
    return posicion + ' de ' + Math.max(compartida.total, compartida.orden.length);
  }

  function mostrarCompartidaEnVisor(ref) {
    const d = compartida.datos[ref];
    if (!d) return;
    refVisor = ref;
    const indice = compartida.orden.indexOf(ref);
    const local = fotoLocalDe(ref);
    // La copia del teléfono solo se usa si está completa (no una miniatura recuperada).
    const url = d.fotoUrl || (local && (local.archivo || local.jpeg) ? local.url : null);

    el.visorImagen.alt = 'Fotografía compartida ' + textoContadorCompartida(ref);
    mostrarBotonGuardar(ref);
    el.visorAnterior.disabled = indice <= 0;
    el.visorSiguiente.disabled = indice >= compartida.orden.length - 1 && !compartida.siguiente;

    if (url) {
      el.visorImagen.src = url;
      el.visorContador.textContent = textoContadorCompartida(ref);
      return;
    }
    // Mientras llega la foto grande se muestra la miniatura (si existe).
    if (d.miniaturaUrl) el.visorImagen.src = d.miniaturaUrl;
    else el.visorImagen.removeAttribute('src');
    el.visorContador.textContent = textoContadorCompartida(ref) + ' · Cargando…';
    cargarFotoGrande(ref);
  }

  // Descarga la foto COMPLETA una sola vez, aunque la pidan a la vez el
  // visor y «Guardar fotografía». Resuelve { ok } o { ok:false, codigo }.
  function descargarFotoCompleta(ref) {
    const d = compartida.datos[ref];
    if (!d) return Promise.resolve({ ok: false, codigo: 'no-disponible' });
    if (d.fotoBlob) return Promise.resolve({ ok: true });
    if (d.promesaFoto) return d.promesaFoto;
    d.promesaFoto = consultarGaleria({ accion: 'foto', ref: ref }, TIEMPO_FOTO_MS).then(function (r) {
      d.promesaFoto = null;
      if (r.respondio && r.json.ok && r.json.ref === ref &&
          r.json.tipo === 'image/jpeg' && typeof r.json.datos === 'string') {
        d.fotoBlob = blobDesdeBase64(r.json.datos, 'image/jpeg');
        d.fotoUrl = URL.createObjectURL(d.fotoBlob);
        recordarFotoGrande(ref);
        return { ok: true };
      }
      return { ok: false, codigo: r.respondio ? r.json.codigo : r.motivo };
    });
    return d.promesaFoto;
  }

  async function cargarFotoGrande(ref) {
    const token = ++compartida.tokenVisor;
    const resultado = await descargarFotoCompleta(ref);
    const d = compartida.datos[ref];
    // Si el invitado ya pasó a otra foto o cerró el visor, no se toca la pantalla.
    if (token !== compartida.tokenVisor || refVisor !== ref || el.visor.hidden) return;
    if (d && d.fotoUrl) {
      el.visorImagen.src = d.fotoUrl;
      el.visorContador.textContent = textoContadorCompartida(ref);
    } else {
      const motivo = resultado.codigo === 'no-disponible'
        ? 'Esta fotografía ya no está disponible'
        : 'No se pudo cargar en alta calidad';
      el.visorContador.textContent = textoContadorCompartida(ref) + ' · ' + motivo;
    }
  }

  // Conserva solo las últimas fotos grandes vistas (memoria del teléfono).
  function recordarFotoGrande(ref) {
    compartida.fotosGrandes.push(ref);
    while (compartida.fotosGrandes.length > MAX_FOTOS_GRANDES_EN_MEMORIA) {
      const antigua = compartida.fotosGrandes.shift();
      const d = compartida.datos[antigua];
      if (antigua === refVisor || antigua === guardado.ref) {
        compartida.fotosGrandes.push(antigua);
        break;
      }
      if (d && d.fotoUrl) {
        URL.revokeObjectURL(d.fotoUrl);
        d.fotoUrl = null;
        d.fotoBlob = null;
      }
    }
  }

  // -- «Guardar fotografía» (una foto a la vez; sin descargas masivas) --

  // ref: foto cuyo botón está en un estado especial; estado: 'preparando' | 'lista' | 'hecho' | 'error'
  const guardado = { ref: null, estado: 'normal', temporizador: null };

  // iPhone y iPad: el menú compartir permite «Guardar imagen» en Fotos.
  // Android y computadoras: descarga directa del archivo JPEG.
  function usarMenuCompartir() {
    const ua = navigator.userAgent || '';
    const esIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return esIOS && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  }

  function estadoGuardar(ref, estado, texto) {
    if (guardado.temporizador) clearTimeout(guardado.temporizador);
    guardado.temporizador = null;
    guardado.ref = estado === 'normal' ? null : ref;
    guardado.estado = estado;
    if (ref !== refVisor) return; // el visor muestra otra foto: no se toca el botón
    const boton = el.visorGuardar;
    boton.classList.toggle('preparando', estado === 'preparando');
    boton.disabled = estado === 'preparando';
    boton.setAttribute('aria-busy', estado === 'preparando' ? 'true' : 'false');
    boton.textContent = texto || 'Guardar fotografía';
    // «Listo» y los errores vuelven solos al estado normal (salvo «lista»,
    // que espera el toque del invitado en iPhone).
    if (estado === 'hecho' || estado === 'error') {
      guardado.temporizador = setTimeout(function () { estadoGuardar(ref, 'normal'); }, 3000);
    }
  }

  // Al cambiar de foto en el visor, el botón muestra el estado de la foto nueva.
  function mostrarBotonGuardar(ref) {
    el.visorGuardar.hidden = false;
    if (guardado.ref === ref && guardado.estado === 'preparando') {
      estadoGuardar(ref, 'preparando', 'Preparando…');
    } else if (guardado.ref === ref && guardado.estado === 'lista') {
      estadoGuardar(ref, 'lista', 'Toca para guardar');
    } else {
      estadoGuardar(ref, 'normal');
    }
  }

  function nombreArchivoGuardado(ref) {
    return 'Hector-Martha-' + ref + '.jpg';
  }

  async function guardarFotoActual() {
    const ref = refVisor;
    if (fuenteVisor !== 'compartida' || !ref) return;
    const d = compartida.datos[ref];
    if (!d) return;

    // La foto completa ya está en el teléfono: se entrega en el mismo toque
    // (en iPhone, el menú compartir exige que se abra directamente al tocar).
    if (d.fotoBlob) {
      entregarFoto(ref, d.fotoBlob);
      return;
    }
    if (guardado.ref === ref && guardado.estado === 'preparando') return;

    estadoGuardar(ref, 'preparando', 'Preparando…');
    const resultado = await descargarFotoCompleta(ref);
    if (!resultado.ok || !d.fotoBlob) {
      estadoGuardar(ref, 'error', resultado.codigo === 'no-disponible'
        ? 'Fotografía no disponible'
        : 'No se pudo preparar · Reintentar');
      return;
    }
    // Si el invitado cambió de foto o cerró el visor, no se descarga nada.
    if (refVisor !== ref || el.visor.hidden) {
      estadoGuardar(ref, 'normal');
      return;
    }
    if (usarMenuCompartir()) {
      estadoGuardar(ref, 'lista', 'Toca para guardar');
    } else {
      entregarFoto(ref, d.fotoBlob);
    }
  }

  function entregarFoto(ref, blob) {
    const nombre = nombreArchivoGuardado(ref);
    if (usarMenuCompartir()) {
      let archivo = null;
      try { archivo = new File([blob], nombre, { type: 'image/jpeg' }); } catch (e) { archivo = null; }
      if (archivo && navigator.canShare({ files: [archivo] })) {
        navigator.share({ files: [archivo], title: 'Héctor & Martha' }).then(function () {
          estadoGuardar(ref, 'hecho', 'Listo ✓');
        }, function (error) {
          // El invitado cerró el menú sin guardar: no es un error.
          if (error && error.name === 'AbortError') {
            estadoGuardar(ref, 'normal');
          } else {
            descargarArchivo(ref, blob, nombre);
          }
        });
        return;
      }
    }
    descargarArchivo(ref, blob, nombre);
  }

  function descargarArchivo(ref, blob, nombre) {
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombre;
    enlace.rel = 'noopener';
    enlace.style.display = 'none';
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    estadoGuardar(ref, 'hecho', 'Descargada ✓');
  }

  async function moverVisorCompartida(paso) {
    const indice = compartida.orden.indexOf(refVisor);
    if (indice < 0) return;
    let nuevo = indice + paso;
    if (nuevo >= compartida.orden.length && compartida.siguiente) {
      el.visorSiguiente.disabled = true;
      await cargarMasCompartidas();
      if (fuenteVisor !== 'compartida' || el.visor.hidden) return;
    }
    if (nuevo < 0 || nuevo >= compartida.orden.length) {
      mostrarCompartidaEnVisor(refVisor);
      return;
    }
    const ref = compartida.orden[nuevo];
    mostrarCompartidaEnVisor(ref);
    if (history.state && history.state.pantalla === 'visor') {
      history.replaceState({ pantalla: 'visor', fuente: 'compartida', ref: ref }, '');
    }
  }

  // -- Pestañas y actualización automática moderada --

  function compartidaVisible() {
    return !el.seccionGaleria.hidden && pestanaGaleria === 'compartida' && !document.hidden;
  }

  function mostrarPestana(nombre) {
    pestanaGaleria = nombre === 'mia' ? 'mia' : 'compartida';
    const esCompartida = pestanaGaleria === 'compartida';
    el.pestanaCompartida.setAttribute('aria-selected', esCompartida ? 'true' : 'false');
    el.pestanaMia.setAttribute('aria-selected', esCompartida ? 'false' : 'true');
    el.panelCompartida.hidden = !esCompartida;
    el.panelMia.hidden = esCompartida;
    actualizarBotonLimpiar();
    if (esCompartida) {
      reanudarCompartida();
    } else {
      detenerActualizacion();
    }
  }

  function reanudarCompartida() {
    if (!compartida.cargada) {
      cargarGaleriaCompartida();
    } else if (compartida.desactualizada || Date.now() - compartida.ultimaConsulta > INTERVALO_ACTUALIZACION_MS) {
      buscarFotosNuevas();
    }
    programarActualizacion();
  }

  // Solo consulta mientras la galería compartida está a la vista y la
  // pestaña del navegador está activa. No interrumpe el visor: las fotos
  // nuevas se agregan a la cuadrícula sin cambiar la foto que se está viendo.
  function programarActualizacion() {
    detenerActualizacion();
    compartida.temporizador = setTimeout(function () {
      compartida.temporizador = null;
      if (!compartidaVisible()) return; // se reanuda al volver a la galería
      buscarFotosNuevas().then(programarActualizacion, programarActualizacion);
    }, INTERVALO_ACTUALIZACION_MS);
  }

  function detenerActualizacion() {
    if (compartida.temporizador) clearTimeout(compartida.temporizador);
    compartida.temporizador = null;
  }

  // Llamado cuando una foto de este invitado se guarda en Drive.
  function avisarFotoCompartidaNueva() {
    compartida.desactualizada = true;
    if (compartida.cargada && compartidaVisible()) buscarFotosNuevas();
  }

  // Al volver a la pestaña o al recuperar la conexión: consulta enseguida
  // (si pasó el intervalo) y reprograma la siguiente consulta.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (compartidaVisible()) reanudarCompartida();
  });
  window.addEventListener('online', function () {
    if (compartidaVisible()) reanudarCompartida();
  });

  /* ---------- Envío a Google Drive (Google Apps Script) ---------- */

  // Id aleatorio de 32 caracteres hexadecimales, uno por fotografía.
  function nuevoIdSubida() {
    if (window.crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '');
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  function esperar(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function enProceso(foto) {
    return foto.estadoSubida === 'en-espera' || foto.estadoSubida === 'preparando' || foto.estadoSubida === 'subiendo';
  }

  function puedeReintentarse(foto) {
    return foto.estadoSubida !== 'guardada' && !enProceso(foto) && foto.reintentable;
  }

  // Texto corto del estado para la galería y el visor.
  function etiquetaEstado(foto) {
    if (foto.estadoSubida === 'guardada') return { texto: 'Compartida', clase: 'guardada' };
    if (enProceso(foto)) return { texto: 'Enviando…', clase: 'pendiente' };
    return { texto: 'No enviada', clase: 'error' };
  }

  // -- Preparación: JPEG optimizado, sin metadatos (el canvas no copia EXIF/GPS) --

  function cargarImagen(archivo) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(archivo);
      const img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('no-se-pudo-leer')); };
      img.src = url;
    });
  }

  // Dibuja la imagen con su orientación correcta, sin deformarla, y la
  // guarda como JPEG. Libera la memoria del canvas al terminar.
  function aJpeg(img, lado, calidad) {
    return new Promise(function (resolve) {
      const w0 = img.naturalWidth;
      const h0 = img.naturalHeight;
      if (!w0 || !h0) return resolve(null);
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
        canvas.width = 0;
        canvas.height = 0;
        resolve(blob ? { blob: blob, ancho: ancho, alto: alto } : null);
      }, 'image/jpeg', calidad);
    });
  }

  async function optimizarFoto(archivo) {
    const carga = await cargarImagen(archivo);
    try {
      let resultado = await aJpeg(carga.img, LADO_MAXIMO, CALIDAD);
      if (resultado && resultado.blob.size > LIMITE_OPTIMIZADA) {
        resultado = await aJpeg(carga.img, LADO_REDUCIDO, CALIDAD_REDUCIDA);
      }
      if (!resultado || resultado.blob.size > LIMITE_SERVIDOR) throw new Error('no-se-pudo-optimizar');
      return resultado;
    } finally {
      URL.revokeObjectURL(carga.url);
    }
  }

  function blobABase64(blob) {
    return new Promise(function (resolve, reject) {
      const lector = new FileReader();
      lector.onload = function () { resolve(String(lector.result).split(',')[1] || ''); };
      lector.onerror = function () { reject(lector.error); };
      lector.readAsDataURL(blob);
    });
  }

  // -- Comunicación (mismo método que funcionó en Mac y en Safari de iPhone) --
  // POST «simple»: cuerpo de texto SIN cabeceras propias (viaja como
  // text/plain, sin consulta previa de CORS), sin cookies, siguiendo la
  // redirección de Apps Script a script.googleusercontent.com.
  // Nunca lanza errores: devuelve { respondio, json } o { respondio:false, motivo }.
  async function llamarServidor(cuerpo) {
    const controlador = new AbortController();
    const limite = setTimeout(function () { controlador.abort(); }, TIEMPO_LIMITE_MS);
    try {
      const respuesta = await fetch(URL_SERVIDOR, {
        method: 'POST',
        body: cuerpo,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
        signal: controlador.signal
      });
      const texto = await respuesta.text();
      let json = null;
      try { json = JSON.parse(texto); } catch (e) { json = null; }
      if (!json || typeof json !== 'object') return { respondio: false, motivo: 'respuesta-no-json' };
      return { respondio: true, json: json };
    } catch (error) {
      return { respondio: false, motivo: error && error.name === 'AbortError' ? 'tiempo-agotado' : 'red' };
    } finally {
      clearTimeout(limite);
    }
  }

  // Decide qué significa la respuesta para esta foto.
  // final=false → se reintenta automáticamente con el mismo id.
  function evaluarRespuesta(r, foto) {
    if (!r.respondio) return { final: false };
    const j = r.json;
    if (j.servicio !== SERVICIO) {
      return { final: true, estado: 'sin-confirmar', reintentable: true };
    }
    if (j.ok === true) {
      // Confirmación real: el servidor guardó exactamente esta foto.
      if (j.id === foto.idSubida && j.tamano === foto.jpeg.blob.size) {
        return { final: true, estado: 'guardada', referencia: j.referencia };
      }
      return { final: true, estado: 'sin-confirmar', reintentable: true };
    }
    if (j.codigo === 'subidas-desactivadas') {
      return { final: true, estado: 'desactivadas', reintentable: true };
    }
    if (CODIGOS_TEMPORALES.indexOf(j.codigo) !== -1) return { final: false };
    if (j.codigo === 'clave-invalida') {
      return {
        final: true, estado: 'rechazada', reintentable: false,
        mensaje: 'La aplicación no pudo identificarse ante el servidor. Avisa a los organizadores; tu fotografía sigue en este dispositivo.'
      };
    }
    return {
      final: true,
      estado: 'rechazada',
      reintentable: CODIGOS_DEFINITIVOS.indexOf(j.codigo) === -1,
      mensaje: typeof j.mensaje === 'string' && j.mensaje ? j.mensaje : 'El servidor no aceptó la fotografía.'
    };
  }

  // Prepara y envía UNA foto, con reintentos automáticos.
  async function subirFoto(foto) {
    if (foto.estadoSubida === 'guardada') return;

    if (!PATRON_URL_SERVIDOR.test(URL_SERVIDOR)) {
      cambiarEstado(foto, 'rechazada', {
        reintentable: false,
        mensaje: 'La aplicación todavía no está configurada para enviar fotografías.'
      });
      return;
    }

    // 1. Preparar (solo la primera vez; los reintentos reutilizan el JPEG).
    if (!foto.jpeg) {
      if (!foto.archivo) {
        cambiarEstado(foto, 'rechazada', {
          reintentable: false,
          mensaje: 'Esta fotografía ya no está guardada en el teléfono para enviarla.'
        });
        return;
      }
      cambiarEstado(foto, 'preparando');
      try {
        foto.jpeg = await optimizarFoto(foto.archivo);
        // En «Mi galería» se reemplaza el original por la versión optimizada (más ligera).
        guardarEnMiGaleria(foto);
      } catch (e) {
        cambiarEstado(foto, 'rechazada', {
          reintentable: false,
          mensaje: 'No pudimos preparar esta fotografía para enviarla. Prueba con otra.'
        });
        return;
      }
    }

    // 2. Enviar, reintentando con el MISMO id.
    let cuerpo;
    try {
      const base64 = await blobABase64(foto.jpeg.blob);
      cuerpo = JSON.stringify({ clave: CLAVE_EVENTO, id: foto.idSubida, tipo: 'image/jpeg', datos: base64 });
    } catch (e) {
      cambiarEstado(foto, 'sin-confirmar', { reintentable: true });
      return;
    }

    for (let intento = 0; intento <= ESPERAS_REINTENTO_MS.length; intento++) {
      cambiarEstado(foto, 'subiendo', { intento: intento });
      const veredicto = evaluarRespuesta(await llamarServidor(cuerpo), foto);
      if (veredicto.final) {
        if (veredicto.estado === 'guardada') {
          // Referencia pública de la foto en la galería compartida: permite
          // reconocerla allí (distintivo «Tuya») y reutilizar la imagen local.
          // Se asigna ANTES de cambiar el estado para que «Mi galería» la guarde.
          if (typeof veredicto.referencia === 'string') foto.referencia = veredicto.referencia;
          foto.jpeg = null; // ya no se necesita
        }
        cambiarEstado(foto, veredicto.estado, veredicto);
        if (veredicto.estado === 'guardada') avisarFotoCompartidaNueva();
        return;
      }
      if (intento < ESPERAS_REINTENTO_MS.length) await esperar(ESPERAS_REINTENTO_MS[intento]);
    }
    cambiarEstado(foto, 'sin-confirmar', { reintentable: true });
  }

  function encolarSubida(foto) {
    if (colaSubidas.indexOf(foto) === -1) colaSubidas.push(foto);
    procesarCola();
  }

  async function procesarCola() {
    if (procesandoCola) return;
    procesandoCola = true;
    try {
      while (colaSubidas.length > 0) {
        const foto = colaSubidas.shift();
        try {
          await subirFoto(foto);
        } catch (e) {
          // Nunca dejar una foto «enviándose» para siempre.
          cambiarEstado(foto, 'sin-confirmar', { reintentable: true });
        }
      }
    } finally {
      procesandoCola = false;
    }
  }

  // Reintento manual: mismo id, así el servidor no la duplica.
  function reintentarSubida(foto) {
    if (!foto || !puedeReintentarse(foto)) return;
    foto.requiereConfirmacion = false; // el invitado decidió reintentar
    cambiarEstado(foto, 'en-espera');
    encolarSubida(foto);
  }

  function reintentarPendientes() {
    fotosConfirmadas.forEach(function (foto) {
      if (puedeReintentarse(foto)) reintentarSubida(foto);
    });
  }

  // -- Estado visible --

  function cambiarEstado(foto, nuevoEstado, datos) {
    datos = datos || {};
    foto.estadoSubida = nuevoEstado;
    foto.mensajeSubida = datos.mensaje || '';
    foto.intentoSubida = datos.intento || 0;
    if (typeof datos.reintentable === 'boolean') foto.reintentable = datos.reintentable;
    // Los estados estables se guardan en «Mi galería» (no los pasos intermedios).
    if (nuevoEstado !== 'preparando' && nuevoEstado !== 'subiendo') guardarEnMiGaleria(foto);

    if (foto === fotoActual) mostrarEstadoConfirmacion(foto);
    const boton = el.cuadricula.querySelector('.galeria-miniatura[data-id="' + foto.id + '"]');
    if (boton) actualizarMiniatura(foto, boton);
    actualizarBotonReintentarPendientes();
    if (fuenteVisor === 'local' && indiceVisor >= 0 && fotosConfirmadas[indiceVisor] === foto) mostrarFotoEnVisor(indiceVisor);
  }

  // Textos de la pantalla de confirmación para cada estado.
  function textosEstado(foto) {
    switch (foto.estadoSubida) {
      case 'en-espera':
        return { titulo: 'Fotografía en espera', texto: 'Se enviará en cuanto termine la anterior. No cierres esta página.', tipo: '' };
      case 'preparando':
        return { titulo: 'Preparando fotografía…', texto: 'Estamos optimizando tu fotografía para compartirla.', tipo: '' };
      case 'subiendo':
        return {
          titulo: 'Subiendo fotografía…',
          texto: foto.intentoSubida > 0
            ? 'La conexión tardó en responder. Reintentando (intento ' + (foto.intentoSubida + 1) + ' de ' + (ESPERAS_REINTENTO_MS.length + 1) + ')…'
            : 'No cierres esta página hasta que termine.',
          tipo: ''
        };
      case 'guardada':
        return { titulo: 'Fotografía compartida correctamente', texto: '¡Gracias! Tu fotografía ya está guardada para Héctor & Martha.', tipo: 'exito' };
      case 'desactivadas':
        return {
          titulo: 'Subidas temporalmente desactivadas',
          texto: 'En este momento no se están recibiendo fotografías. La tuya se conserva en este dispositivo mientras la página siga abierta; puedes reintentar más tarde.',
          tipo: ''
        };
      case 'rechazada':
        return { titulo: 'No se pudo compartir la fotografía', texto: foto.mensajeSubida || 'El servidor no aceptó la fotografía.', tipo: 'error' };
      default: // 'sin-confirmar'
        return {
          titulo: 'No se pudo confirmar el guardado',
          texto: 'Puede ser la conexión. Tu fotografía sigue en este dispositivo: pulsa «Reintentar subida» (no se duplicará).',
          tipo: 'error'
        };
    }
  }

  function mostrarEstadoConfirmacion(foto) {
    const t = textosEstado(foto);
    el.seccionConfirmacion.setAttribute('data-estado', foto.estadoSubida);
    el.tituloConfirmacion.textContent = t.titulo;
    el.textoConfirmacion.textContent = t.texto;
    el.textoConfirmacion.className = 'mensaje' + (t.tipo ? ' mensaje-' + t.tipo : '');

    const mostrarReintento = puedeReintentarse(foto);
    el.btnReintentarSubida.hidden = !mostrarReintento;
    // Con «Reintentar» visible, «Elegir otra» pasa a segundo plano.
    el.btnOtra.classList.toggle('boton-secundario', mostrarReintento);
  }

  function actualizarMiniatura(foto, boton, indice, total) {
    const etiqueta = etiquetaEstado(foto);
    const distintivo = boton.querySelector('span');
    if (distintivo) {
      distintivo.className = 'galeria-estado galeria-estado-' + etiqueta.clase;
      distintivo.textContent = etiqueta.texto;
    }
    if (typeof indice === 'number') {
      boton.setAttribute('data-indice', indice);
      boton.setAttribute('data-total', total);
    }
    const i = Number(boton.getAttribute('data-indice'));
    const n = Number(boton.getAttribute('data-total'));
    boton.setAttribute('aria-label', 'Ver fotografía ' + (i + 1) + ' de ' + n + ' (' + etiqueta.texto + ')');
  }

  function actualizarBotonReintentarPendientes() {
    let pendientes = 0;
    fotosConfirmadas.forEach(function (foto) {
      if (puedeReintentarse(foto)) pendientes++;
    });
    el.btnReintentarPendientes.hidden = pendientes === 0;
    el.btnReintentarPendientes.textContent = pendientes === 1
      ? 'Reintentar envío pendiente'
      : 'Reintentar envíos pendientes (' + pendientes + ')';
  }

  // Al recuperar la conexión, se reintentan solas las que no se confirmaron
  // por un problema de red (no las rechazadas ni las de subidas desactivadas).
  // Las recuperadas de una visita anterior esperan a que el invitado lo pida.
  window.addEventListener('online', function () {
    fotosConfirmadas.forEach(function (foto) {
      if (foto.estadoSubida === 'sin-confirmar' && foto.reintentable && !foto.requiereConfirmacion) reintentarSubida(foto);
    });
  });

  // Aviso al cerrar o recargar (en computadoras; Safari de iPhone puede
  // ignorarlo) si hay un envío en curso o una foto sin enviar que no se pudo
  // guardar en el teléfono.
  window.addEventListener('beforeunload', function (evento) {
    const hayPendientes = fotosConfirmadas.some(function (foto) {
      return enProceso(foto) || (foto.estadoSubida !== 'guardada' && foto.reintentable && !foto.copiaLocal);
    });
    if (hayPendientes) {
      evento.preventDefault();
      evento.returnValue = '';
    }
  });

  /* ---------- «Mi galería» persistente (IndexedDB, solo este navegador) ---------- */

  // Se guarda en el navegador de ESTE teléfono (no en otros dispositivos):
  //   - fichas:  una por foto (estado, código del servidor y miniatura pequeña).
  //   - envios:  copia para reenviar SOLO de las fotos aún no compartidas
  //              (primero el original; en cuanto se optimiza, el JPEG listo,
  //              más ligero). Al compartirse, la copia se borra.
  // Si no hay espacio, el navegador lo impide (modo privado) o falla algo,
  // la app sigue funcionando como antes (solo en memoria) y lo avisa.

  const BD_NOMBRE = 'hector-martha-mi-galeria';
  const BD_FICHAS = 'fichas';
  const BD_ENVIOS = 'envios';
  const MAX_COPIAS_PENDIENTES = 40;                  // fotos sin enviar con copia guardada
  const MAX_BYTES_LOCALES = 200 * 1024 * 1024;       // tope prudente para este sitio
  const MAX_BYTES_ORIGINAL_LOCAL = 15 * 1024 * 1024; // originales enormes: se espera a optimizarlos

  const almacen = { bd: null, escrituras: {} };

  function abrirBaseLocal() {
    return new Promise(function (resolve) {
      let peticion;
      try {
        if (!window.indexedDB) return resolve(null);
        peticion = indexedDB.open(BD_NOMBRE, 1);
      } catch (e) {
        return resolve(null);
      }
      peticion.onupgradeneeded = function () {
        const bd = peticion.result;
        if (!bd.objectStoreNames.contains(BD_FICHAS)) bd.createObjectStore(BD_FICHAS, { keyPath: 'id' });
        if (!bd.objectStoreNames.contains(BD_ENVIOS)) bd.createObjectStore(BD_ENVIOS, { keyPath: 'id' });
      };
      peticion.onsuccess = function () { resolve(peticion.result); };
      peticion.onerror = function () { resolve(null); };
      peticion.onblocked = function () { resolve(null); };
    });
  }

  // Ejecuta una operación en un almacén y espera a que la transacción termine.
  function operacionLocal(almacenNombre, modo, accion) {
    return new Promise(function (resolve, reject) {
      if (!almacen.bd) return reject(new Error('sin-base-local'));
      let transaccion;
      try {
        transaccion = almacen.bd.transaction(almacenNombre, modo);
      } catch (e) {
        return reject(e);
      }
      let resultado;
      const peticion = accion(transaccion.objectStore(almacenNombre));
      if (peticion) peticion.onsuccess = function () { resultado = peticion.result; };
      transaccion.oncomplete = function () { resolve(resultado); };
      transaccion.onerror = function () { reject(transaccion.error); };
      transaccion.onabort = function () { reject(transaccion.error || new Error('abortada')); };
    });
  }

  // Se guardan ArrayBuffer (no Blob) por compatibilidad con Safari.
  function datosDe(blob) {
    return blob.arrayBuffer ? blob.arrayBuffer() : new Response(blob).arrayBuffer();
  }

  function avisoMiGaleria(texto) {
    el.miGaleriaAviso.textContent = texto || '';
    el.miGaleriaAviso.hidden = !texto;
  }

  function esFaltaDeEspacio(error) {
    return !!error && (error.name === 'QuotaExceededError' || /quota|espacio/i.test(String(error.message || '')));
  }

  async function hayEspacioLocal(bytes) {
    const copias = fotosConfirmadas.filter(function (f) { return f.copiaLocal && f.estadoSubida !== 'guardada'; }).length;
    if (copias >= MAX_COPIAS_PENDIENTES) return false;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        const limite = Math.min(MAX_BYTES_LOCALES, (e.quota || Infinity) * 0.8);
        if ((e.usage || 0) + bytes > limite) return false;
      }
    } catch (e) { /* sin estimación: se intenta igual */ }
    return true;
  }

  // Guarda (o actualiza) una foto en «Mi galería». Las escrituras de una
  // misma foto se hacen en orden; los errores nunca interrumpen la app.
  function guardarEnMiGaleria(foto) {
    if (!almacen.bd || foto.borrada) return Promise.resolve();
    const anterior = almacen.escrituras[foto.id] || Promise.resolve();
    const siguiente = anterior.then(function () { return escribirEnMiGaleria(foto); }).catch(function () {});
    almacen.escrituras[foto.id] = siguiente;
    return siguiente;
  }

  async function escribirEnMiGaleria(foto) {
    if (!almacen.bd || foto.borrada) return;
    const sinCompartir = foto.estadoSubida !== 'guardada' && foto.reintentable !== false;
    const fuente = foto.jpeg ? foto.jpeg.blob : foto.archivo;

    // 1. Copia para reenviar: solo mientras no se haya compartido.
    if (sinCompartir && fuente && foto.copiaDe !== fuente) {
      const aceptable = foto.jpeg || fuente.size <= MAX_BYTES_ORIGINAL_LOCAL;
      if (aceptable && await hayEspacioLocal(fuente.size)) {
        try {
          const datos = await datosDe(fuente);
          await operacionLocal(BD_ENVIOS, 'readwrite', function (s) {
            return s.put({ id: foto.id, tipo: fuente.type || 'image/jpeg', optimizado: !!foto.jpeg, datos: datos });
          });
          foto.copiaDe = fuente;
          foto.copiaLocal = true;
        } catch (error) {
          if (esFaltaDeEspacio(error)) {
            avisoMiGaleria('No queda espacio en este teléfono para guardar las fotos sin enviar. Compártelas antes de cerrar la página.');
          }
        }
      } else if (foto.jpeg && !foto.copiaLocal) {
        avisoMiGaleria('No queda espacio en este teléfono para guardar las fotos sin enviar. Compártelas antes de cerrar la página.');
      }
    } else if (!sinCompartir && foto.copiaLocal) {
      // Compartida (o imposible de enviar): ya no hace falta la copia grande.
      try {
        await operacionLocal(BD_ENVIOS, 'readwrite', function (s) { return s.delete(foto.id); });
      } catch (e) { /* se reintenta en la siguiente escritura */ }
      foto.copiaLocal = false;
      foto.copiaDe = null;
    }

    // 2. Ficha (pequeña): estado, código del servidor y miniatura.
    if (!foto.datosMiniatura && foto.miniaturaBlob) {
      foto.datosMiniatura = { tipo: foto.miniaturaBlob.type || 'image/jpeg', datos: await datosDe(foto.miniaturaBlob) };
    }
    const ficha = {
      id: foto.id,
      idSubida: foto.idSubida,
      estadoSubida: foto.estadoSubida,
      mensajeSubida: foto.mensajeSubida || '',
      reintentable: foto.reintentable !== false,
      referencia: foto.referencia || null,
      origen: foto.origen || null,
      confirmadaEn: foto.confirmadaEn.getTime(),
      miniatura: foto.datosMiniatura || null,
      tieneCopia: !!foto.copiaLocal
    };
    try {
      await operacionLocal(BD_FICHAS, 'readwrite', function (s) { return s.put(ficha); });
    } catch (error) {
      if (esFaltaDeEspacio(error)) {
        avisoMiGaleria('No queda espacio en este teléfono para guardar «Mi galería». Las fotos se verán mientras la página siga abierta.');
      }
    }
  }

  // Reconstruye una foto de «Mi galería» a partir de lo guardado.
  function fotoDesdeFicha(ficha, envio) {
    const miniatura = ficha.miniatura ? new Blob([ficha.miniatura.datos], { type: ficha.miniatura.tipo }) : null;
    const copia = envio ? new Blob([envio.datos], { type: envio.tipo }) : null;
    const miniaturaUrl = miniatura ? URL.createObjectURL(miniatura) : null;

    // Lo que estaba en camino cuando se cerró la página queda «No enviada»:
    // NO se reenvía solo; el invitado decide con «Reintentar».
    const enCamino = ['en-espera', 'preparando', 'subiendo'].indexOf(ficha.estadoSubida) !== -1;
    let estado = enCamino ? 'sin-confirmar' : ficha.estadoSubida;
    let reintentable = ficha.reintentable !== false;
    let mensaje = ficha.mensajeSubida || '';
    if (estado !== 'guardada' && !copia) {
      estado = 'rechazada';
      reintentable = false;
      mensaje = 'Esta fotografía no se pudo conservar en el teléfono para enviarla.';
    }

    return {
      id: ficha.id,
      archivo: copia && !envio.optimizado ? copia : null,
      jpeg: copia && envio.optimizado ? { blob: copia } : null,
      origen: ficha.origen,
      confirmadaEn: new Date(ficha.confirmadaEn),
      url: copia ? URL.createObjectURL(copia) : (miniaturaUrl || ''),
      miniaturaUrl: miniaturaUrl,
      miniaturaBlob: miniatura,
      datosMiniatura: ficha.miniatura || null,
      idSubida: ficha.idSubida,
      estadoSubida: estado,
      mensajeSubida: mensaje,
      intentoSubida: 0,
      reintentable: reintentable,
      referencia: ficha.referencia || null,
      copiaLocal: !!copia,
      copiaDe: copia,
      restaurada: true,
      requiereConfirmacion: true // nunca se reintenta sola tras recargar
    };
  }

  async function iniciarMiGaleria() {
    almacen.bd = await abrirBaseLocal();
    if (!almacen.bd) {
      avisoMiGaleria('Este navegador no permite guardar «Mi galería» (por ejemplo, en modo privado). Tus fotos se verán mientras la página siga abierta.');
      return;
    }
    // Pide al navegador que no borre estos datos por falta de espacio (si lo permite).
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) { /* opcional */ }

    let fichas = [];
    try {
      fichas = await operacionLocal(BD_FICHAS, 'readonly', function (s) { return s.getAll(); }) || [];
    } catch (e) {
      fichas = [];
    }
    fichas.sort(function (a, b) { return a.confirmadaEn - b.confirmadaEn; });

    const recuperadas = [];
    for (let i = 0; i < fichas.length; i++) {
      const ficha = fichas[i];
      if (fotosConfirmadas.some(function (f) { return f.id === ficha.id; })) continue;
      let envio = null;
      if (ficha.tieneCopia) {
        try { envio = await operacionLocal(BD_ENVIOS, 'readonly', function (s) { return s.get(ficha.id); }); } catch (e) { envio = null; }
      }
      recuperadas.push(fotoDesdeFicha(ficha, envio));
    }
    // Las recuperadas van primero (son anteriores a las de esta visita).
    Array.prototype.unshift.apply(fotosConfirmadas, recuperadas);
    // Las fotos confirmadas antes de que la base estuviera lista también se guardan.
    fotosConfirmadas.forEach(function (foto) { if (!foto.restaurada) guardarEnMiGaleria(foto); });

    actualizarBotonesGaleria();
    if (!el.seccionGaleria.hidden) renderizarGaleria();
    actualizarBotonReintentarPendientes();
    // Los distintivos «Tuya» de la galería compartida usan los códigos recuperados.
    Object.keys(compartida.datos).forEach(pintarMiniatura);
  }

  /* ---------- Cuadro de diálogo (estilo SweetAlert, con los colores de la boda) ---------- */

  // mostrarDialogo({ icono, exito, titulo, texto, aviso, aceptar, cancelar })
  // → Promise<boolean>: true si se pulsa «aceptar». Sin «cancelar» es un aviso
  // de un solo botón. Escape o tocar fuera de la tarjeta equivale a cancelar.
  let cerrarDialogoActual = null;

  function mostrarDialogo(opciones) {
    if (cerrarDialogoActual) cerrarDialogoActual(false);
    const anterior = document.activeElement;
    el.dialogoIcono.style.setProperty('--icono', 'url("assets/iconos/' + (opciones.icono || 'corazon') + '.svg")');
    el.dialogoIcono.classList.toggle('dialogo-icono-exito', !!opciones.exito);
    el.dialogoTitulo.textContent = opciones.titulo || '';
    el.dialogoTexto.textContent = opciones.texto || '';
    el.dialogoAviso.textContent = opciones.aviso || '';
    el.dialogoAviso.hidden = !opciones.aviso;
    el.dialogoAceptar.textContent = opciones.aceptar || 'Aceptar';
    el.dialogoCancelar.textContent = opciones.cancelar || 'Cancelar';
    el.dialogoCancelar.hidden = !opciones.cancelar;
    el.dialogo.hidden = false;
    document.body.classList.add('dialogo-abierto');
    // El foco empieza en la opción segura (Cancelar), o en el único botón.
    (opciones.cancelar ? el.dialogoCancelar : el.dialogoAceptar).focus();

    return new Promise(function (resolve) {
      function terminar(respuesta) {
        el.dialogo.hidden = true;
        document.body.classList.remove('dialogo-abierto');
        el.dialogoAceptar.removeEventListener('click', alAceptar);
        el.dialogoCancelar.removeEventListener('click', alCancelar);
        el.dialogo.removeEventListener('click', alTocarFondo);
        document.removeEventListener('keydown', alTeclear, true);
        cerrarDialogoActual = null;
        if (anterior && document.body.contains(anterior) && anterior.focus) anterior.focus();
        resolve(respuesta);
      }
      function alAceptar() { terminar(true); }
      function alCancelar() { terminar(false); }
      function alTocarFondo(e) { if (e.target === el.dialogo) terminar(false); }
      function alTeclear(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          terminar(false);
        }
      }
      cerrarDialogoActual = terminar;
      el.dialogoAceptar.addEventListener('click', alAceptar);
      el.dialogoCancelar.addEventListener('click', alCancelar);
      el.dialogo.addEventListener('click', alTocarFondo);
      document.addEventListener('keydown', alTeclear, true);
    });
  }

  // «Limpiar Mi galería»: borra lo guardado en ESTE teléfono. No toca Google
  // Drive ni la galería compartida.
  async function limpiarMiGaleria() {
    if (fotosConfirmadas.some(enProceso)) {
      await mostrarDialogo({
        icono: 'repetir',
        titulo: 'Un momento, por favor',
        texto: 'Todavía se están enviando fotografías. Espera a que terminen y vuelve a intentarlo.',
        aceptar: 'Entendido'
      });
      return;
    }
    const sinEnviar = fotosConfirmadas.filter(function (f) { return f.estadoSubida !== 'guardada'; }).length;
    const confirmado = await mostrarDialogo({
      icono: 'limpiar',
      titulo: '¿Limpiar «Mi galería»?',
      texto: 'Se borrarán las fotos guardadas en este teléfono. No te preocupes: las fotografías compartidas siguen en Google Drive y en la galería de todos.',
      aviso: sinEnviar > 0
        ? (sinEnviar === 1
          ? 'Hay 1 fotografía que todavía no se ha enviado y se perderá.'
          : 'Hay ' + sinEnviar + ' fotografías que todavía no se han enviado y se perderán.')
        : '',
      aceptar: 'Sí, limpiar',
      cancelar: 'Cancelar'
    });
    if (!confirmado) return;

    fotosConfirmadas.forEach(function (foto) {
      foto.borrada = true;
      [foto.url, foto.miniaturaUrl, foto.urlGrande].forEach(function (u) { if (u) URL.revokeObjectURL(u); });
    });
    fotosConfirmadas.length = 0;
    colaSubidas.length = 0;
    fotoActual = null;
    almacen.escrituras = {};
    try {
      await operacionLocal(BD_FICHAS, 'readwrite', function (s) { return s.clear(); });
      await operacionLocal(BD_ENVIOS, 'readwrite', function (s) { return s.clear(); });
    } catch (e) { /* sin base local: solo se limpia la memoria */ }

    avisoMiGaleria('');
    renderizarGaleria();
    actualizarBotonesGaleria();
    Object.keys(compartida.datos).forEach(pintarMiniatura); // quita los distintivos «Tuya»

    await mostrarDialogo({
      icono: 'confirmado',
      exito: true,
      titulo: '«Mi galería» está limpia',
      texto: 'Las fotografías compartidas siguen disponibles en la galería de todos.',
      aceptar: 'Listo'
    });
  }

  /* ---------- Cámara integrada (getUserMedia) ---------- */

  // getUserMedia solo existe en contextos seguros: HTTPS o localhost.
  // Por HTTP desde otra dirección (p. ej. http://192.168.x.x) no está disponible.
  function camaraIntegradaDisponible() {
    return window.isSecureContext !== false &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function';
  }

  // Detiene todas las pistas de video y libera la cámara del dispositivo.
  function detenerPistas() {
    if (camara.stream) {
      camara.stream.getTracks().forEach(function (pista) {
        pista.onended = null;
        pista.stop();
      });
      camara.stream = null;
    }
    el.camaraVideo.pause();
    el.camaraVideo.srcObject = null;
    el.camaraDisparador.disabled = true;
  }

  // estadoUI: 'cargando' | 'lista' | 'error'
  function mostrarEstadoCamara(estadoUI, titulo, texto) {
    el.camaraCargando.hidden = estadoUI !== 'cargando';
    el.camaraError.hidden = estadoUI !== 'error';
    el.camara.classList.toggle('camara-lista', estadoUI === 'lista');
    if (estadoUI === 'error') {
      el.camaraErrorTitulo.textContent = titulo;
      el.camaraErrorTexto.textContent = texto;
      el.camaraUsarNativa.focus();
    }
  }

  function mostrarErrorCamara(error) {
    detenerPistas();
    const nombre = error && error.name;
    let titulo = 'No pudimos abrir la cámara';
    let texto = 'Ocurrió un problema al acceder a la cámara. Inténtalo de nuevo o usa la cámara de tu teléfono.';

    if (nombre === 'NotAllowedError' || nombre === 'PermissionDeniedError' || nombre === 'SecurityError') {
      titulo = 'Permiso de cámara denegado';
      texto = 'Para usar la cámara aquí, permite el acceso a la cámara en los ajustes de tu navegador y vuelve a intentarlo. También puedes usar la cámara de tu teléfono.';
    } else if (nombre === 'NotFoundError' || nombre === 'DevicesNotFoundError' || nombre === 'OverconstrainedError') {
      titulo = 'No encontramos una cámara';
      texto = 'Este dispositivo no tiene una cámara disponible. Puedes elegir una fotografía de tu galería.';
    } else if (nombre === 'NotReadableError' || nombre === 'TrackStartError' || nombre === 'AbortError') {
      titulo = 'La cámara está ocupada';
      texto = 'Otra aplicación podría estar usando la cámara. Ciérrala e inténtalo de nuevo, o usa la cámara de tu teléfono.';
    } else if (nombre === 'CamaraDetenida') {
      titulo = 'La cámara se detuvo';
      texto = 'Se interrumpió la cámara. Inténtalo de nuevo o usa la cámara de tu teléfono.';
    } else if (nombre === 'TiempoAgotado') {
      texto = 'La cámara tardó demasiado en responder. Inténtalo de nuevo o usa la cámara de tu teléfono.';
    }

    mostrarEstadoCamara('error', titulo, texto);
  }

  // Espera a que el video tenga imagen (dimensiones conocidas).
  function esperarVideo(video) {
    return new Promise(function (resolve, reject) {
      let temporizador = null;
      function limpiar() {
        clearTimeout(temporizador);
        video.removeEventListener('loadedmetadata', comprobar);
        video.removeEventListener('playing', comprobar);
      }
      function comprobar() {
        if (video.videoWidth > 0) {
          limpiar();
          resolve();
        }
      }
      temporizador = setTimeout(function () {
        limpiar();
        reject({ name: 'TiempoAgotado' });
      }, 10000);
      video.addEventListener('loadedmetadata', comprobar);
      video.addEventListener('playing', comprobar);
      const reproduccion = video.play();
      if (reproduccion && reproduccion.catch) reproduccion.catch(function () {});
      comprobar();
    });
  }

  // Muestra el botón de cambiar cámara solo si hay más de una.
  function actualizarBotonCambiar() {
    if (!navigator.mediaDevices.enumerateDevices) {
      el.camaraCambiar.hidden = true;
      return Promise.resolve();
    }
    return navigator.mediaDevices.enumerateDevices().then(function (dispositivos) {
      const camaras = dispositivos.filter(function (d) { return d.kind === 'videoinput'; });
      el.camaraCambiar.hidden = camaras.length < 2;
    }).catch(function () {
      el.camaraCambiar.hidden = true;
    });
  }

  // Inicia la transmisión. "exacto" se usa al cambiar de cámara para
  // forzar la frontal o la trasera; si no existe, se acepta la disponible.
  function iniciarCamara(modo, exacto) {
    const solicitud = ++camara.solicitud;
    detenerPistas(); // algunos Android no permiten abrir dos cámaras a la vez
    camara.modo = modo;
    mostrarEstadoCamara('cargando');

    const restricciones = {
      audio: false,
      video: {
        facingMode: exacto ? { exact: modo } : { ideal: modo },
        // Resolución deseada; el navegador elige la más cercana disponible.
        width: { ideal: 2560 },
        height: { ideal: 1440 }
      }
    };

    navigator.mediaDevices.getUserMedia(restricciones)
      .catch(function (error) {
        if (exacto && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
          restricciones.video.facingMode = { ideal: modo };
          return navigator.mediaDevices.getUserMedia(restricciones);
        }
        throw error;
      })
      .then(function (stream) {
        // Si mientras tanto se cerró la cámara o se pidió otra, liberar esta.
        if (solicitud !== camara.solicitud || !camara.abierta) {
          stream.getTracks().forEach(function (p) { p.stop(); });
          return;
        }
        camara.stream = stream;

        const pista = stream.getVideoTracks()[0];
        const ajustes = pista && pista.getSettings ? pista.getSettings() : {};
        camara.espejo = (ajustes.facingMode || modo) === 'user';
        el.camaraVideo.classList.toggle('camara-video-espejo', camara.espejo);

        if (pista) {
          // Por ejemplo, si otra aplicación toma la cámara.
          pista.onended = function () {
            if (camara.abierta && solicitud === camara.solicitud) {
              mostrarErrorCamara({ name: 'CamaraDetenida' });
            }
          };
        }

        el.camaraVideo.srcObject = stream;
        return esperarVideo(el.camaraVideo).then(function () {
          if (solicitud !== camara.solicitud) return;
          el.camaraDisparador.disabled = false;
          mostrarEstadoCamara('lista');
          return actualizarBotonCambiar();
        });
      })
      .catch(function (error) {
        if (solicitud !== camara.solicitud || !camara.abierta) return;
        mostrarErrorCamara(error);
      });
  }

  function abrirCamara() {
    // Respaldo: sin cámara integrada se usa la cámara nativa del teléfono.
    if (!camaraIntegradaDisponible()) {
      abrirSelector('camara');
      return;
    }
    if (camara.abierta) return;

    camara.abierta = true;
    ocultarMensaje();
    el.camaraCambiar.hidden = true;
    el.camara.hidden = false;
    document.body.classList.add('camara-abierta');
    history.pushState({ pantalla: 'camara' }, '');
    el.camaraCerrar.focus();
    iniciarCamara(camara.modo);
  }

  // Cierra la interfaz y libera la cámara (sin tocar el historial).
  function cerrarCamaraUI() {
    if (!camara.abierta) return;
    camara.abierta = false;
    camara.capturando = false;
    camara.pausadaEnSegundoPlano = false;
    camara.solicitud++;
    detenerPistas();
    el.camara.hidden = true;
    document.body.classList.remove('camara-abierta');
    mostrarEstadoCamara('cargando');
  }

  function cerrarCamara() {
    const habiaEntrada = history.state && history.state.pantalla === 'camara';
    cerrarCamaraUI(); // se libera la cámara de inmediato
    if (habiaEntrada) history.back();
  }

  function nombreFotoCapturada(fecha) {
    function dos(n) { return (n < 10 ? '0' : '') + n; }
    return 'foto-' + fecha.getFullYear() + dos(fecha.getMonth() + 1) + dos(fecha.getDate()) +
      '-' + dos(fecha.getHours()) + dos(fecha.getMinutes()) + dos(fecha.getSeconds()) + '.jpg';
  }

  // Convierte el fotograma actual en una fotografía JPEG y abre la vista previa.
  function capturarFoto() {
    const video = el.camaraVideo;
    if (camara.capturando || !camara.stream || !video.videoWidth) return;
    camara.capturando = true;
    el.camaraDisparador.disabled = true;

    const ancho = video.videoWidth;
    const alto = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = ancho;
    canvas.height = alto;
    const contexto = canvas.getContext('2d');
    if (camara.espejo) {
      // La foto se guarda igual a como se veía en pantalla.
      contexto.translate(ancho, 0);
      contexto.scale(-1, 1);
    }
    contexto.drawImage(video, 0, 0, ancho, alto);

    // Efecto de destello.
    el.camaraFlash.classList.remove('activo');
    void el.camaraFlash.offsetWidth;
    el.camaraFlash.classList.add('activo');

    canvas.toBlob(function (blob) {
      // Liberar la memoria del canvas (importante en iPhone).
      canvas.width = 0;
      canvas.height = 0;
      camara.capturando = false;

      if (!blob) {
        mostrarErrorCamara({ name: 'ErrorCaptura' });
        return;
      }
      const fecha = new Date();
      const nombre = nombreFotoCapturada(fecha);
      let archivo;
      try {
        archivo = new File([blob], nombre, { type: 'image/jpeg', lastModified: fecha.getTime() });
      } catch (e) {
        archivo = blob; // navegadores muy antiguos sin el constructor File
        archivo.name = nombre;
      }

      cerrarCamara();
      mostrarVistaPrevia(archivo, 'camara-integrada');
    }, 'image/jpeg', 0.92);
  }

  // Abre la cámara nativa o la galería desde la interfaz de cámara.
  // Se llama dentro del clic para que iOS y Android permitan abrir el selector.
  function salirDeCamaraHacia(origen) {
    abrirSelector(origen);
    cerrarCamara();
  }

  // Al pasar a otra aplicación se libera la cámara; al volver, se reactiva.
  document.addEventListener('visibilitychange', function () {
    if (!camara.abierta) return;
    if (document.hidden) {
      camara.solicitud++;
      detenerPistas();
      camara.pausadaEnSegundoPlano = true;
    } else if (camara.pausadaEnSegundoPlano) {
      camara.pausadaEnSegundoPlano = false;
      if (el.camaraError.hidden) iniciarCamara(camara.modo);
    }
  });

  window.addEventListener('pagehide', cerrarCamaraUI);

  // Botones atrás/adelante del navegador o del teléfono.
  window.addEventListener('popstate', function (evento) {
    const datos = evento.state || {};
    // "Atrás" con la cámara abierta la cierra y libera.
    if (datos.pantalla !== 'camara') cerrarCamaraUI();
    if (datos.pantalla === 'camara') {
      // "Adelante" hacia una cámara ya cerrada: no se reabre sola.
    } else if (datos.pantalla === 'visor' && datos.fuente === 'compartida' && compartida.datos[datos.ref]) {
      if (el.seccionGaleria.hidden) mostrarGaleriaUI();
      mostrarVisorCompartidaUI(datos.ref);
    } else if (datos.pantalla === 'visor' && datos.fuente !== 'compartida' && fotosConfirmadas[datos.indice]) {
      mostrarGaleriaUI();
      mostrarVisorUI(datos.indice);
    } else if (datos.pantalla === 'galeria' || datos.pantalla === 'visor') {
      cerrarVisorUI();
      if (el.seccionGaleria.hidden) mostrarGaleriaUI();
    } else {
      cerrarVisorUI();
      if (!el.seccionGaleria.hidden) mostrarInicioUI();
    }
  });

  /* ---------- Eventos ---------- */

  // "Tomar fotografía": cámara integrada; si no está disponible, la nativa.
  el.btnTomar.addEventListener('click', abrirCamara);

  el.btnSeleccionar.addEventListener('click', function () {
    abrirSelector('galeria');
  });

  // "Repetir": vuelve a abrir el mismo origen (cámara o galería).
  // Si el usuario cancela, se mantiene la fotografía anterior.
  el.btnRepetir.addEventListener('click', function () {
    if (estado.origen === 'camara-integrada') {
      abrirCamara();
    } else {
      abrirSelector(estado.origen || 'galeria');
    }
  });

  el.btnCancelar.addEventListener('click', function () {
    reiniciar();
    ocultarMensaje();
  });

  el.btnConfirmar.addEventListener('click', confirmarFotografia);

  el.btnOtra.addEventListener('click', elegirOtra);

  // «Reintentar subida» (pantalla de confirmación) y «Reintentar envíos
  // pendientes» (galería): siempre con el mismo id de cada foto.
  el.btnReintentarSubida.addEventListener('click', function () {
    reintentarSubida(fotoActual);
  });
  el.btnReintentarPendientes.addEventListener('click', reintentarPendientes);
  el.btnLimpiarMiGaleria.addEventListener('click', limpiarMiGaleria);

  el.btnsVerGaleria.forEach(function (boton) {
    boton.addEventListener('click', abrirGaleria);
  });

  el.btnVolverInicio.addEventListener('click', volverAlInicio);

  // Pestañas y botones de la galería compartida.
  el.pestanaCompartida.addEventListener('click', function () { mostrarPestana('compartida'); });
  el.pestanaMia.addEventListener('click', function () { mostrarPestana('mia'); });
  el.btnActualizarGaleria.addEventListener('click', function () {
    cargarGaleriaCompartida().then(programarActualizacion);
  });
  el.btnCargarMas.addEventListener('click', cargarMasCompartidas);

  el.visorCerrar.addEventListener('click', cerrarVisor);
  el.visorGuardar.addEventListener('click', guardarFotoActual);
  el.visorAnterior.addEventListener('click', function () { moverVisor(-1); });
  el.visorSiguiente.addEventListener('click', function () { moverVisor(1); });

  // Tocar el fondo oscuro (fuera de la foto y los botones) cierra el visor.
  el.visor.addEventListener('click', function (e) {
    if (e.target === el.visor || e.target.classList.contains('visor-marco')) {
      cerrarVisor();
    }
  });

  // Teclado (útil al probar en computadora).
  // Controles de la cámara integrada.
  el.camaraDisparador.addEventListener('click', capturarFoto);
  el.camaraCerrar.addEventListener('click', cerrarCamara);
  el.camaraErrorCerrar.addEventListener('click', cerrarCamara);
  el.camaraReintentar.addEventListener('click', function () {
    iniciarCamara(camara.modo);
  });
  el.camaraCambiar.addEventListener('click', function () {
    if (camara.capturando) return;
    iniciarCamara(camara.modo === 'user' ? 'environment' : 'user', true);
  });
  el.camaraUsarNativa.addEventListener('click', function () {
    salirDeCamaraHacia('camara');
  });
  el.camaraGaleria.addEventListener('click', function () {
    salirDeCamaraHacia('galeria');
  });

  document.addEventListener('keydown', function (e) {
    if (camara.abierta) {
      if (e.key === 'Escape') cerrarCamara();
      return;
    }
    if (el.visor.hidden) return;
    if (e.key === 'Escape') cerrarVisor();
    else if (e.key === 'ArrowLeft') moverVisor(-1);
    else if (e.key === 'ArrowRight') moverVisor(1);
  });

  el.inputCamara.addEventListener('change', function (e) {
    manejarSeleccion(e, 'camara');
  });

  el.inputGaleria.addEventListener('change', function (e) {
    manejarSeleccion(e, 'galeria');
  });

  // Acceso de solo lectura para las siguientes etapas.
  window.BodaFotos = {
    // Fotografía en vista previa (aún sin confirmar), o null.
    obtenerFotografia: function () {
      return estado.archivo;
    },
    // Copia de la lista de fotografías confirmadas, con su estado de envío
    // (estadoSubida: 'guardada' = confirmada por el servidor).
    obtenerFotografiasConfirmadas: function () {
      return fotosConfirmadas.slice();
    }
  };

  actualizarBotonesGaleria();
  iniciarMiGaleria(); // recupera «Mi galería» guardada en este teléfono
})();
