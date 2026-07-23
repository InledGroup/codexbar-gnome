import sys
import json
import argparse
from codexbar_cookie_importer.importer import extract_tokens

def main():
    """
    Main entry point for the console script.
    Punto de entrada principal para el script de consola.
    """
    parser = argparse.ArgumentParser(description="Import browser cookies for CodexBar providers.")
    parser.add_argument("--provider", choices=["codex", "ollama"], default="codex")
    args = parser.parse_args()

    try:
        result = extract_tokens(args.provider)
        print(json.dumps(result))
        # If there's an error in extraction, exit with 1 for better pipeline handling
        # Si hay un error en la extracción, salir con código 1 para un mejor manejo en tuberías
        if "error" in result:
            sys.exit(1)
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"error": "UNEXPECTED_EXCEPTION", "details": str(e)}))
        sys.exit(2)

if __name__ == "__main__":
    main()
