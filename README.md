# ConectaQ OLT NMS Pro v10

Panel de gestión para OLT VSOL de 8 puertos PON.

## Novedades v10

### 🔧 Correcciones
- **Reiniciar ONT correctamente**: Al reiniciar una ONT desde el modal de edición, el estado se marca como "reiniciando..." inmediatamente y se actualiza solo ~30 segundos después con el estado real del OLT.
- **Resync individual de ONT**: Botón "🔄 Estado" en el modal consulta solo esa ONT al OLT vía Telnet y actualiza el estado + potencia sin recargar todo.
- **Resync de configuración**: La función de resincronización ahora refresca datos reales de la ONT activa.

### ➕ Funciones nuevas — OLT Info
- **Pestaña 🖥️ OLT Info**: CPU, Memoria (%), Uptime, Temperatura, Versión de firmware.
- Parseo inteligente de los comandos `show version`, `show system cpu`, `show system memory`, `show system temperature`.
- Muestra barras de progreso de CPU y memoria con colores (verde/naranja/rojo).
- Salida raw del OLT para diagnóstico.

### 📜 Eventos reales
- Los eventos (reinicio ONT, borrar, autorizar, mover, crear VLAN) quedan guardados en `events_log.json`.
- La pestaña "Eventos" muestra el log real en lugar de datos de ejemplo.

## Ejecutar

```bash
npm install
npm start
```

Abre `http://localhost:3000`

## Configuración

El archivo `olts.json` guarda los OLTs registrados (se crea automáticamente).
Por defecto conecta a `170.246.112.83:2333` con usuario `ConectaQ`.

## Archivos de datos
- `olts.json` — OLTs registrados
- `customers.json` — Datos de clientes por serial
- `onts_cache.json` — Caché de ONTs (TTL 2 min)
- `moves_queue.json` — Cola de movimientos pendientes
- `power_history.json` — Historial de potencia por serial
- `events_log.json` — Log de eventos del sistema

## Estructura
```
├── server.js         ← Backend Node.js + Telnet
├── package.json
├── public/
│   └── index.html    ← Frontend completo
└── README.md
```
