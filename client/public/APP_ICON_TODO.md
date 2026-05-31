# WarriorFIT AI App Icon TODO

The current `logo.png` is a temporary rectangular brand logo fallback. Do not use it as the final native app icon source.

Before Capacitor/native wrapper work, add final square PNG icon assets generated from approved WarriorFIT AI app artwork:

- `icon-192.png` - 192x192 PNG
- `icon-512.png` - 512x512 PNG
- `apple-touch-icon.png` - 180x180 PNG
- native source icon - 1024x1024 PNG for iOS/Android generation

After those files exist, update:

- `manifest.json` icon entries to use the square `icon-192.png` and `icon-512.png`
- `../index.html` favicon and apple touch icon links to use the final square assets

