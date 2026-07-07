# ConectaQ OLT

Panel local para un OLT VSOL de 8 puertos PON. Muestra solamente:

- ONTs por PON
- Potencia optica de cada ONT

## Ejecutar

```powershell
npm start
```

Abre:

```text
http://localhost:3000
```

## Configuracion

Por defecto consulta el OLT en `192.168.8.200:23`.

Puedes cambiar los datos sin editar codigo:

```powershell
$env:OLT_HOST="192.168.8.200"
$env:OLT_PORT="23"
$env:OLT_USER="ConectaQ"
$env:OLT_PASS="tu_password"
$env:OLT_ENABLE_PASS="password_enable"
$env:OLT_COMMAND_TIMEOUT="7000"
npm start
```

Si tu VSOL usa comandos distintos, define estos dos:

```powershell
$env:OLT_ONTS_COMMAND="show gpon onu state"
$env:OLT_POWER_COMMAND="show gpon onu optical-power all"
npm start
```

## Nota

El backend intenta varios perfiles de comandos VSOL/genericos. Si entra al OLT pero aparece todo en cero, falta ajustar los comandos exactos que devuelve tu modelo/firmware para listar ONTs y potencia optica.

En este OLT el usuario Telnet entra primero en modo limitado (`>`). Para consultar ONTs normalmente se necesita modo privilegiado (`#`) con `enable`. Si el panel muestra que falta password de enable, define `OLT_ENABLE_PASS` antes de iniciar.
