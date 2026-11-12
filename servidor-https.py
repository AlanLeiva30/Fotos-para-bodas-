#!/usr/bin/env python3
"""
Servidor HTTPS local para probar la página de la boda Alfaro & Vásquez
desde el iPhone o Android en la misma red Wi-Fi.

- Solo usa la biblioteca estándar de Python (no instala nada).
- Usa el certificado generado con mkcert en la carpeta certs/.
- Solo sirve archivos; no recibe ni guarda fotografías.
- Es para pruebas: no usar como servidor definitivo.

Uso (desde la carpeta del proyecto):
    python3 servidor-https.py
Luego abre en el teléfono:
    https://MacBook-Air-de-Alan.local:8443   o   https://192.168.0.21:8443
Detener: Ctrl + C
"""

import functools
import http.server
import os
import posixpath
import socket
import ssl
import sys
import urllib.parse

PUERTO = 8443
CARPETA = os.path.dirname(os.path.abspath(__file__))
CERTIFICADO = os.path.join(CARPETA, "certs", "boda-local.pem")
CLAVE = os.path.join(CARPETA, "certs", "boda-local-key.pem")


class Manejador(http.server.SimpleHTTPRequestHandler):
    """Sirve los archivos del proyecto sin caché, para ver siempre la última versión."""

    # Nunca entregar la clave del certificado, carpetas ocultas ni este script.
    BLOQUEADOS = ("/certs", "/.", "/servidor-https.py")

    def _bloqueado(self):
        ruta = urllib.parse.unquote(self.path.split("?", 1)[0].split("#", 1)[0])
        # En macOS las rutas no distinguen mayúsculas: se compara en minúsculas.
        ruta = posixpath.normpath(ruta).lower()
        return any(ruta == b or ruta.startswith(b) for b in self.BLOQUEADOS)

    def do_GET(self):
        if self._bloqueado():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if self._bloqueado():
            self.send_error(404)
            return
        super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def ip_local():
    """IP de la Mac en la red Wi-Fi (sin enviar datos a ningún lado)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    if not (os.path.exists(CERTIFICADO) and os.path.exists(CLAVE)):
        sys.exit("No se encontró el certificado en certs/. Genéralo primero con mkcert.")

    contexto = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    contexto.minimum_version = ssl.TLSVersion.TLSv1_2
    contexto.load_cert_chain(CERTIFICADO, CLAVE)

    manejador = functools.partial(Manejador, directory=CARPETA)
    servidor = http.server.ThreadingHTTPServer(("0.0.0.0", PUERTO), manejador)
    servidor.socket = contexto.wrap_socket(servidor.socket, server_side=True)

    nombre = socket.gethostname()
    if not nombre.endswith(".local"):
        nombre += ".local"
    print("Servidor HTTPS de prueba activo:")
    print("  https://localhost:%d" % PUERTO)
    print("  https://%s:%d" % (nombre, PUERTO))
    print("  https://%s:%d" % (ip_local(), PUERTO))
    print("Si la IP cambió, el certificado no la incluye: usa la dirección .local")
    print("Detener: Ctrl + C")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
