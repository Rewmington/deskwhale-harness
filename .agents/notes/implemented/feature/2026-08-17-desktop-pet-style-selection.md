# Agent Note: Desktop pet style selection

Status: implemented

English | [中文](2026-08-17-desktop-pet-style-selection.zh.md)

## Problem

The desktop pet has one fixed full-color maid illustration, so users cannot choose a mature black-and-white maid outfit while retaining state-specific poses, animation timing, and pixel hit testing.

## Decision

The desktop shell persists `style` beside `enabled` in `pet-settings.json`. It accepts `classic` and `black-white-maid`, falls back to `classic` for missing or invalid values, and retains existing enabled settings when either preference changes.

The pet context menu and system tray expose the same radio selector. Selecting a style writes the preference and sends an immediate renderer message that replaces the image for the current status pose.

`black-white-maid` selects five dedicated transparent PNGs: idle, two working poses, approval waiting, and dragging. The renderer caches the classic and black-and-white assets for alpha hit testing, and resolves the active style whenever a status image changes. The title-bar button uses the active outfit's idle image.

## Alternatives considered

**Apply a grayscale filter to the classic art.** Rejected because it turns skin, hair, and the whale tail monochrome instead of presenting a black-and-white maid outfit.

**Use a single replacement image for every status.** Rejected because working, waiting, and dragging need distinct action poses.

**Keep the selector only in the pet context menu.** Rejected because a hidden pet still needs a desktop-level path to inspect and choose its style.

## Consequences

Users can choose the black-and-white maid outfit from either desktop menu, and the choice survives restart. The mature maid keeps natural skin, indigo-purple hair, and the whale tail while using black-and-white uniform art. Additional styles require one `PET_STYLE_OPTIONS` entry, one state asset map, and matching title-bar thumbnail.
