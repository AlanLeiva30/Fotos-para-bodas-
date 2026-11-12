/*
 * Héctor & Martha — Configuración PÚBLICA de la aplicación.
 *
 * Todo lo que hay en este archivo es visible para cualquiera que abra la
 * página (como el resto del código del navegador). Por eso aquí NUNCA deben
 * ir contraseñas de Google, tokens privados ni credenciales de Drive.
 *
 * - urlServidor: aplicación web de Google Apps Script (termina en /exec).
 * - claveEvento: identificador PÚBLICO del evento. No es una contraseña:
 *   solo ayuda a filtrar peticiones al azar. Las protecciones reales están
 *   en el servidor (interruptor de subidas, límites, validación JPEG y
 *   carpeta de Drive privada). Su valor está en Apps Script →
 *   ⚙️ Configuración del proyecto → Propiedades del script → CLAVE_EVENTO.
 * - servicio: nombre que el servidor incluye en cada respuesta; se usa para
 *   comprobar que la respuesta viene realmente de nuestro servidor.
 */
window.BODA_CONFIG = Object.freeze({
  urlServidor: 'https://script.google.com/macros/s/AKfycbzqZfJonsbR-WAEzfwMt-eQ9SD7QAQmHQl2-qgNFYaB6o5M1kB-HQsyulweSahXjaME3Q/exec',
  claveEvento: 'hm-2c885b4d030a4a33', // identificador público (no es una contraseña)
  servicio: 'hector-martha-pruebas'
});
