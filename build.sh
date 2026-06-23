#!/bin/bash
# Script para empaquetar la extensión

UUID="codexbar@inled.es"

echo "Compilando esquemas..."
glib-compile-schemas schemas/

echo "Empaquetando extensión..."
gnome-extensions pack \
    --extra-source=extension.js \
    --extra-source=prefs.js \
    --extra-source=usageApi.js \
    --extra-source=secret.js \
    --extra-source=stylesheet.css \
    --extra-source=media/ \
    --schema=schemas/org.gnome.shell.extensions.codexbar.gschema.xml \
    --force

echo "Extensión empaquetada en ${UUID}.shell-extension.zip"
