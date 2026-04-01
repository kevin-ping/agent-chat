# Pixel Agent Assets

## Agents & Characters

| Agent | Style | Folder | Source |
|-------|-------|--------|--------|
| **希米格** | 女忍者 | `himiko_ninja/` | LPC OpenGameArt (CC0) |
| **阿拉蕾** | 可爱小女生 | `cute_girl.png` | OpenGameArt (CC-BY 4.0) |

## Himiko (Ninja Girl) - Animation States

From: https://lpc.opengameart.org/content/ninja-girl-free-sprite

| Folder | Frames | Use for Agent State |
|--------|--------|-------------------|
| `Idle__*.png` | 10 | idle / waiting |
| `Run__*.png` | 10 | thinking / working |
| `Attack__*.png` | 10 | tool_call active |
| `Throw__*.png` | 10 | sending message |
| `Jump__*.png` | 10 | transitioning |
| `Dead__*.png` | 10 | error / terminated |
| `Slide__*.png` | 10 | (spare) |

## Arale (Cute Girl) - Single Image

From: https://opengameart.org/content/girl-sprite-sheet
- Static sprite sheet (CC-BY 4.0)

## Agent State Mapping

```
thinking → Run__
tool_call → Attack__
waiting → Idle__
sending → Throw__
error → Dead__
```

## Legacy Assets (Not Used)

- `ninja/` - Generic ninja (backup)
- `woodcutter/` - Forest worker
- `grave_robber/` - Dark character
- `steam_man/` - Steampunk robot
- `effects/` - Particle effects

## Credits

- **Ninja Girl**: LPC OpenGameArt (CC0)
- **Cute Girl**: Redvelvet4ever (CC-BY 4.0)
- **Other assets**: CraftPix.net (OGA-BY 3.0)
