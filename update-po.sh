#!/bin/bash
# Script to refresh the translation template and merge it into every language

DOMAIN="codexbar@inled.es"

echo "Extracting strings..."
xgettext --from-code=UTF-8 --language=JavaScript \
    --keyword=_ --keyword=N_ --keyword=tr --keyword=ngettext:1,2 \
    --package-name="CodexBar" --msgid-bugs-address="https://github.com/InledGroup/codexbar-gnome/issues" \
    --output=po/${DOMAIN}.pot \
    extension.js prefs.js usageApi.js localize.js secret.js providerSources.js adapters/*.js

echo "Merging into existing translations..."
shopt -s nullglob
for po in po/*.po; do
    msgmerge --quiet --update --backup=none "$po" po/${DOMAIN}.pot
    msgfmt --check --statistics -o /dev/null "$po"
done
