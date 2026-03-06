# Tagventory Backend

Backend mínimo con MongoDB Atlas y OpenAI. Incluye endpoints de prueba para validar conexiones.

## Requisitos

- Node.js 18 LTS o superior

## Configuración

1. Copia el archivo de ejemplo de variables de entorno:

```bash
cp .env.example .env
```

2. Edita `.env` y completa las variables:

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto del servidor (default: 3000) |
| `MONGO_URI` | URI de conexión a MongoDB Atlas |
| `DB_NAME` | Nombre de la base de datos |
| `OPENAI_API_KEY` | API Key de OpenAI |

**Nota:** Si la contraseña de MongoDB contiene caracteres especiales (ej: `@`), debes codificarlos en URL. Por ejemplo: `@` → `%40`.

## Instalación

```bash
npm install
```

## Ejecución

```bash
npm run dev
```

El servidor se inicia en `http://localhost:3000` (o el puerto configurado).

## Endpoints

### GET /health

Comprueba que el servidor y MongoDB están operativos.

**Ejemplo con curl:**

```bash
curl http://localhost:3000/health
```

**Respuesta exitosa (200):**

```json
{
  "status": "ok",
  "mongo": "ok",
  "dbName": "tagventory",
  "timestamp": "2025-02-13T12:00:00.000Z"
}
```

**Respuesta error MongoDB (500):**

```json
{
  "status": "error",
  "mongo": "fail",
  "message": "Error al conectar con MongoDB"
}
```

### POST /ai/embedding

Genera un embedding de texto usando OpenAI y devuelve las dimensiones y una vista previa.

**Ejemplo con curl:**

```bash
curl -X POST http://localhost:3000/ai/embedding \
  -H "Content-Type: application/json" \
  -d '{"text": "Hola mundo, este es un texto de prueba"}'
```

**Respuesta exitosa (200):**

```json
{
  "dims": 1536,
  "preview": [0.0123, -0.0456, 0.0789, -0.0123, 0.0456]
}
```

**Respuesta error validación (400):**

```json
{
  "status": "error",
  "message": "El campo \"text\" es requerido y no puede estar vacío"
}
```

### POST /ai/assets/backfill-sample

Genera embeddings para activos que aún no los tienen. Usa solo `name + brand + model`.

**Ejemplo con curl:**

```bash
curl -X POST http://localhost:3000/ai/assets/backfill-sample \
  -H "Content-Type: application/json" \
  -d '{"limit": 20}'
```

**Respuesta exitosa (200):**

```json
{ "updated": 15 }
```

### POST /ai/search/assets

Búsqueda semántica general de activos por texto libre.

**Ejemplo con curl:**

```bash
curl -X POST http://localhost:3000/ai/search/assets \
  -H "Content-Type: application/json" \
  -d '{"query": "laptop Dell", "limit": 5}'
```

**Respuesta exitosa (200):**

```json
{
  "results": [
    { "_id": "...", "name": "...", "brand": "...", "model": "...", "locationPath": "...", "serial": "...", "score": 0.85 }
  ]
}
```

### POST /ai/reconciliation/suggestions

**MVP de conciliación con IA.** Compara una descripción SAP (texto libre) contra los activos de Tagventory usando embeddings y vector search sobre `name + brand + model`.

**Ejemplo con curl:**

```bash
curl -X POST http://localhost:3000/ai/reconciliation/suggestions \
  -H "Content-Type: application/json" \
  -d '{"sapDescription": "tanque diesel 2000 litros", "limit": 5}'
```

**Respuesta exitosa (200):**

```json
{
  "query": "tanque diesel 2000 litros",
  "results": [
    { "_id": "...", "name": "Tanque Diesel", "brand": "Acme", "model": "TD-2000", "score": 0.87 },
    { "_id": "...", "name": "Tanque Combustible", "brand": "Acme", "model": "TC-2000", "score": 0.72 }
  ]
}
```

**Respuesta error validación (400):**

```json
{
  "status": "error",
  "message": "El campo \"sapDescription\" es requerido y no puede estar vacío"
}
```

### POST /ai/reconciliation/job

Crea un job de conciliación por lote. Recibe las filas SAP y las persiste sin generar embeddings aún.

**Ejemplo con curl:**

```bash
curl -X POST http://localhost:3000/ai/reconciliation/job \
  -H "Content-Type: application/json" \
  -d '{
    "rows": [
      { "rowNumber": 1, "sapDescription": "IMP LASER HP LJ4000N", "sapLocation": "Mitikah Piso 2" },
      { "rowNumber": 2, "sapDescription": "MONITOR DELL 24 PULGADAS", "sapLocation": "Mitikah Piso 3" }
    ]
  }'
```

**Respuesta (200):**

```json
{ "jobId": "664a...", "totalRows": 2 }
```

### POST /ai/reconciliation/job/:jobId/process

Procesa un job: genera embeddings y ejecuta vector search para cada fila (en serie).

**Ejemplo con curl:**

```bash
curl -X POST http://localhost:3000/ai/reconciliation/job/664a.../process
```

**Respuesta (200):**

```json
{ "status": "completed", "processedRows": 2 }
```

### GET /ai/reconciliation/job/:jobId

Obtiene resultados paginados de un job.

**Ejemplo con curl:**

```bash
curl "http://localhost:3000/ai/reconciliation/job/664a...?offset=0&limit=20"
```

**Respuesta (200):**

```json
{
  "jobId": "664a...",
  "status": "completed",
  "totalRows": 2,
  "processedRows": 2,
  "rows": [
    {
      "rowNumber": 1,
      "sapDescription": "IMP LASER HP LJ4000N",
      "sapLocation": "Mitikah Piso 2",
      "suggestions": [
        { "assetId": "...", "name": "Impresora HP", "brand": "HP", "model": "LJ4000N", "EPC": "...", "locationPath": "...", "score": 0.91 }
      ],
      "decision": "pending",
      "selectedAssetId": null
    }
  ]
}
```

### POST /ai/reconciliation/job/:jobId/decision

Guarda la decisión del usuario sobre una fila del job.

**Ejemplo con curl:**

```bash
curl -X POST http://localhost:3000/ai/reconciliation/job/664a.../decision \
  -H "Content-Type: application/json" \
  -d '{ "rowNumber": 1, "decision": "match", "selectedAssetId": "665b..." }'
```

**Respuesta (200):**

```json
{ "success": true }
```

## Estructura del proyecto

```
src/
├── config/
│   ├── env.js          # Carga y validación de variables de entorno
│   ├── mongo.js        # Conexión MongoDB
│   └── openai.js       # Cliente OpenAI
├── controllers/
│   ├── health.controller.js
│   ├── ai.controller.js
│   └── reconciliation.controller.js
├── routes/
│   ├── health.routes.js
│   └── ai.routes.js
├── services/
│   ├── embedding.service.js
│   ├── backfill.service.js
│   └── reconciliation-job.service.js
├── utils/
│   └── embedding-text.js   # buildAssetEmbeddingText, normalizeText
└── index.js
```

## Script de backfill de embeddings (`scripts/backfill-all.js`)

Este script genera **embeddings para todos los assets que no los tengan** en la colección `assets`.  
Es más robusto y configurable que el endpoint de muestra.

### Configuración previa

- Asegúrate de tener `.env` configurado:

| Variable | Descripción |
|----------|-------------|
| `MONGO_URI` | URI de MongoDB (misma base donde están los assets) |
| `DB_NAME` | Nombre de la base de datos (ej. `tagventory`) |
| `OPENAI_API_KEY` | API Key de OpenAI |
| `EMBEDDING_MODEL` | Modelo de embeddings (recomendado: `text-embedding-3-large`) |
| `EMBEDDING_DIMENSIONS` | Dimensiones del vector (deben coincidir con el índice de MongoDB, p.ej. `1536`) |

- En MongoDB Atlas, el índice vectorial sobre `textEmbedding` debe tener `numDimensions` igual a `EMBEDDING_DIMENSIONS`.

### Uso básico

Desde la carpeta `backend/`:

```bash
node scripts/backfill-all.js
```

El script:

- Conecta a Mongo usando `MONGO_URI` y `DB_NAME`.
- Busca assets sin `textEmbedding`.
- Construye texto de embedding a partir de `name + brand + model`.
- Llama a OpenAI en batches y guarda `textEmbedding`, `embeddingText`, `embeddingVersion` y `embeddingUpdatedAt`.

### Opciones útiles

- **Cambiar tamaño de batch** (por defecto 100):

```bash
node scripts/backfill-all.js --batch=200
```

- **Dry run** (no escribe nada en la base, solo muestra estadísticas):

```bash
node scripts/backfill-all.js --dry-run
```

### Recomendación al cambiar de modelo

Si cambias `EMBEDDING_MODEL` o `EMBEDDING_DIMENSIONS`:

1. Asegúrate de que el índice vectorial en MongoDB tenga el mismo `numDimensions`.
2. Ejecuta de nuevo `scripts/backfill-all.js` para regenerar los embeddings con el nuevo modelo.

---

## Script de backfill por ubicación (`scripts/backfill-by-location.js`)

Genera embeddings **solo para los assets de una ubicación y todas sus hijas y subhijas** (usa la colección `locationsReal` para expandir el árbol).

### Uso

Desde la carpeta `backend/`:

```bash
# Solo assets de EDOMEX y sus hijas/subhijas (sin embedding aún)
node scripts/backfill-by-location.js --location=675a09bf7fecb101a9e86dd4

# Con batch mayor y dry-run para ver cuántos tocaría
node scripts/backfill-by-location.js --location=675a09bf7fecb101a9e86dd4 --batch=200 --dry-run

# Regenerar también los que ya tienen embedding (--refresh)
node scripts/backfill-by-location.js --location=675a09bf7fecb101a9e86dd4 --refresh
```

### Opciones

| Opción | Descripción |
|--------|-------------|
| `--location=<id>` | **Requerido.** ID de la ubicación en `locationsReal` (ej. EDOMEX). |
| `--batch=N` | Tamaño del lote (default: 100). |
| `--dry-run` | Solo muestra estadísticas, no escribe en la base. |
| `--refresh` | Incluye assets que ya tienen embedding (los regenera). |

### Requisitos

- Misma configuración que `backfill-all.js` (`.env` con `MONGO_URI`, `DB_NAME`, `OPENAI_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`).
- Colección `locationsReal` con documentos con `_id` y `parent`.
- Assets con campo `location` (ID de ubicación, string o ObjectId).
