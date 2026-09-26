# VL53L8CX firmware and tables

The doorway counter's sensor arrives with no firmware in it. Every time it
powers on, the host has to load these files into it over I2C before it will
measure anything. `main.py` does that in `Vl53l8cx.init()`.

They are ST's own data, extracted byte for byte from STMicroelectronics' Ultra
Lite Driver as published in the STM32duino VL53L8CX library, and redistributed
under that library's BSD 3-Clause licence (`LICENSE`, beside this file). Nothing
here was written for this project; the port of the code that uses them is in
`main.py`.

Source: https://github.com/stm32duino/VL53L8CX, version 2.1.0, commit
`a93a9d6796f2a74835a4088f225daec343153c62` (2026-07-01), file
`src/vl53l8cx_buffers.h`.

| File | Bytes | SHA-256 | From |
|---|---|---|---|
| `vl53l8cx_firmware.bin` | 86016 | `fc50ff57e426b6c43532042e08a6b4bb7dcc3dac36c9d79787c511ef074e9cda` | `VL53L8CX_FIRMWARE` |
| `vl53l8cx_default_config.bin` | 972 | `5c7b4ed4f1af635829c7306d98276d9ad5d72fdd81e8aa3d445759366d7cb0e7` | `VL53L8CX_DEFAULT_CONFIGURATION` |
| `vl53l8cx_default_xtalk.bin` | 776 | `5278d26d8a6591b78abbc6f67cd07a8014d2379d93fb19eb4c49837768ac3d1a` | `VL53L8CX_DEFAULT_XTALK` |
| `vl53l8cx_get_nvm_cmd.bin` | 40 | `dc5b7eb04c3938e5e718b8c8ce7cbac0e12b532d342891d1e9595fbeab302577` | `VL53L8CX_GET_NVM_CMD` |

**Entry 107 of the default configuration is a macro in the source, not a
number.** `VL53L8CX_FW_NBTAR_RANGING` is 2 when the driver is built for one
target per zone, which is how `main.py` runs it, so that byte is 0x02. An
extractor that took only the literals skipped it and shifted the remaining 864
bytes one place; the sensor would have accepted a configuration that was wrong
everywhere without saying so. The extraction now splits on commas, the way C
counts the entries, and refuses any token it does not recognise.

The firmware also carries its own check: after loading, `init()` reads a
checksum back from the sensor and stops if it is not `0x0C0B6C9E`, so a file
damaged in transit fails loudly on the first boot rather than quietly.
