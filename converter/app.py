#!/usr/bin/env python3
"""Entry point of the installed, self-contained helper.

    logic-importer-helper            run the helper (what macOS starts at login)
    logic-importer-helper convert …  run the converter (the helper starts this itself)
"""
import sys


def main() -> int:
    if sys.argv[1:2] == ["convert"]:
        del sys.argv[1]
        import convert
        return convert.main()
    import helper
    return helper.main()


if __name__ == "__main__":
    sys.exit(main())
