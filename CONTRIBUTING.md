[https://help.inled.es/help/contribute-to-inled-projects/](https://help.inled.es/help/contribute-to-inled-projects/).  
In addition:
- Please add to test_all_providers.js the test for the provider you implemented.
- Wrap any new user-facing string in `_()` and run `./update-po.sh` so it lands in the translation template.

## Translations

Translations live in `po/`. To add a language:

1. Run `./update-po.sh` to refresh `po/codexbar@inled.es.pot`.
2. Create the catalog: `msginit --input=po/codexbar@inled.es.pot --locale=xx_XX --output=po/xx_XX.po`.
3. Translate it, add the code to `po/LINGUAS` and run `./build.sh` (it compiles every `.po` into the package).

Text that comes from codexbar-cli in English (window labels, detail rows, reset times) is translated at render time by `localize.js`.
