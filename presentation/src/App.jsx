import React, { useState, useEffect, useCallback } from 'react'
import { TilePyramidChart, MemoryEnvelopeChart } from './Charts'

function SentryGlyph({ size = 32 }) {
  return (
    <svg viewBox="0 0 72 66" width={size} height={size} aria-hidden="true">
      <g transform="translate(11, 11)">
        <path d="M29,2.26a4.67,4.67,0,0,0-8,0L14.42,13.53A32.21,32.21,0,0,1,32.17,40.19H27.55A27.68,27.68,0,0,0,12.09,17.47L6,28a15.92,15.92,0,0,1,9.23,12.17H4.62A.76.76,0,0,1,4,39.06l2.94-5a10.74,10.74,0,0,0-3.36-1.9l-2.91,5a4.54,4.54,0,0,0,1.69,6.24A4.66,4.66,0,0,0,4.62,44H19.15a19.4,19.4,0,0,0-8-17.31l2.31-4A23.87,23.87,0,0,1,23.76,44H36.07a35.88,35.88,0,0,0-16.41-31.8l4.67-8a.77.77,0,0,1,1.05-.27c.53.29,20.29,34.77,20.66,35.17a.76.76,0,0,1-.68,1.13H40.6q.09,1.91,0,3.81h4.78A4.59,4.59,0,0,0,50,39.43a4.49,4.49,0,0,0-.62-2.28Z" fill="#181225" />
      </g>
    </svg>
  )
}

const SLIDES = [
  // 0. Portada
  () => (
    <div className="slide-content">
      <div className="title-logo"><SentryGlyph size={56} /></div>
      <h1>UltraTile</h1>
      <p className="subtitle d1">Servidor asíncrono en Java 21 para imagenes gigantes. El servidor divide cada imagen en tiles de 512 px y envia solo los tiles que cubren la vista actual.</p>
      <div className="pill-row d2">
        <span className="pill">Java 21 con virtual threads</span>
        <span className="pill">Tiles JPEG de 512</span>
        <span className="pill">HTTP más WebSocket</span>
        <span className="pill">Protocolo UTP/1.0</span>
        <span className="pill">RFC 6455</span>
      </div>
      <p className="meta d3">Protocolo, arquitectura, control de transmisión y decisiones de diseño. Sin dependencias externas en ejecucion.</p>
    </div>
  ),

  // 1. Problema
  () => (
    <div className="slide-content">
      <h2>El problema que resuelve el proyecto</h2>
      <p className="subtitle d1">Una imagen panoramica o geografica alcanza cientos de gigapixeles y cientos de gigabytes. Ningun navegador puede recibirla completa.</p>
      <div className="cards d2">
        <div className="card">
          <h3>Si se envia completa</h3>
          <ul className="clean">
            <li>El ancho de banda se agota con datos que el usuario quiza nunca mira.</li>
            <li>La espera se mide en minutos y el navegador se queda sin memoria.</li>
            <li>El equipo del usuario se degrada al decodificar gigapixeles de una vez.</li>
          </ul>
        </div>
        <div className="card">
          <h3>Lo que hace UltraTile</h3>
          <ul className="clean">
            <li>El servidor corta cada imagen en tiles JPEG de 512 px por lado.</li>
            <li>El viewer pide solo el rectangulo visible al zoom actual.</li>
            <li>El cliente guarda máximo 40 tiles y descarta el resto.</li>
          </ul>
        </div>
      </div>
      <p className="foot d3">Regla del proyecto. El servidor nunca transfiere la imagen completa en alta calidad. Esto no es un zoom con CSS. Cada cambio de resolucion transfiere tiles y elimina los que salen de vista.</p>
    </div>
  ),

  // 2. Arquitectura
  () => (
    <div className="slide-content">
      <h2>Arquitectura del sistema</h2>
      <p className="subtitle d1">Cuatro piezas. Cada pieza tiene una tarea exacta y el protocolo UTP/1.0 las une.</p>
      <div className="flow d2">
        <div className="flow-step"><strong>1. Store e import</strong>Genera la piramide de tiles y publica cada imagen con archivo .ready</div>
        <div className="flow-arrow">→</div>
        <div className="flow-step"><strong>2. HTTP bootstrap</strong>Sirve la página, el viewer y los metadatos de cada imagen</div>
        <div className="flow-arrow">→</div>
        <div className="flow-step"><strong>3. Sesiones WS y UTP</strong>Reciben pedidos por viewport y responden tile por tile</div>
        <div className="flow-arrow">→</div>
        <div className="flow-step"><strong>4. Viewer</strong>Pide, decodifica, dibuja y limpia tiles fuera de vista</div>
      </div>
      <div className="cols d3">
        <div className="col card">
          <h3>El servidor es dueno de</h3>
          <p>Los bytes. Guarda los JPEG en disco con rutas canonicas. Valida cada pedido. Decide el orden de envio. Cierra la conexion ante un mensaje ilegal.</p>
        </div>
        <div className="col card">
          <h3>El viewer es dueno de</h3>
          <p>La vista. Calcula que tiles necesita. Suprime los que ya tiene. Cancela el pedido anterior cuando el usuario mueve la cámara.</p>
        </div>
      </div>
    </div>
  ),

  // 3. Piramide de tiles
  () => (
    <div className="slide-content">
      <h2>Piramide de tiles y algoritmo de importación</h2>
      <p className="subtitle d1">La matemática es de techo. Cada nivel reduce a la mitad y redondea hacia arriba. Los bordes se rellenan de negro hasta 512.</p>
      <div className="cards d2">
        <div className="card">
          <h3>Formulas que usa el código</h3>
          <p><code>N = ceil log2 max W H / 512</code></p>
          <p><code>W Z = ceil W / 2 N-Z</code>, mínimo 1</p>
          <p><code>C Z = ceil W Z / 512</code></p>
          <p>Ruta canonica. <code>level-Z / X_Y.jpg</code></p>
        </div>
        <div className="card">
          <h3>Importación en tres pasos</h3>
          <p>1. La herramienta escribe en un directorio temporal.</p>
          <p>2. El validador revisa conteos, medidas 512 y tope de 2 MiB por tile.</p>
          <p>3. El rename atomico publica el arbol y crea el archivo .ready.</p>
        </div>
      </div>
      <div className="chart-wrap d3">
        <TilePyramidChart />
        <p className="foot">Datos exactos del diseño. Demo 0 de 2048 px suma 21 tiles. Demo 1 de 4096 px suma 85 tiles. Total 106 tiles en disco.</p>
      </div>
    </div>
  ),

  // 4. Protocolo
  () => (
    <div className="slide-content">
      <h2>Protocolo UTP/1.0 y sus mensajes</h2>
      <p className="subtitle d1">Cinco mensajes binarios en big endian. Cada mensaje empieza con el byte magico AA. Los tamanos son fijos salvo el tile.</p>
      <table className="compare d2">
        <thead><tr><th>Código</th><th>Mensaje</th><th>Tamano</th><th>Quien lo envia y para que</th></tr></thead>
        <tbody>
          <tr><td><code>0x01</code></td><td>Viewport chunk</td><td>28 B</td><td>Viewer. Describe un rango de tiles con imageId, zoom, reqId y esquinas.</td></tr>
          <tr><td><code>0x05</code></td><td>Commit</td><td>8 B</td><td>Viewer. Sella la generacion y pide el despacho.</td></tr>
          <tr><td><code>0x03</code></td><td>Abort</td><td>8 B</td><td>Viewer. Cancela una generacion con par imageId y reqId.</td></tr>
          <tr><td><code>0x02</code></td><td>Tile</td><td>24 B más JPEG</td><td>Servidor. Lleva imageId, zoom, formato, reqId, x, y y largo.</td></tr>
          <tr><td><code>0x04</code></td><td>End</td><td>16 B</td><td>Servidor. Cierra la generacion con contadores sent y skipped.</td></tr>
        </tbody>
      </table>
      <div className="cards d3" style={{ marginTop: 14 }}>
        <div className="card"><h3>Políticas fijas</h3><p>LOD 0 es el único modo activo. Formato 1 JPEG es el único que el servidor emite. Cada reqId nace en 1, nunca se repite y nunca se reinicia al cambiar de imagen.</p></div>
        <div className="card"><h3>Limites que protegen al servidor</h3><p>Rango máximo 128 tiles por chunk. Generacion maxima 256 tiles unicos. Tile máximo 2 MiB. Mensaje entrante máximo 1 KiB.</p></div>
      </div>
    </div>
  ),

  // 5. Comunicación y TCP
  () => (
    <div className="slide-content">
      <h2>Como se comunican los componentes</h2>
      <p className="subtitle d1">HTTP carga la página. WebSocket mueve los tiles. Todo corre sobre TCP. UDP queda fuera por decisión técnica.</p>
      <div className="flow d2">
        <div className="flow-step"><strong>HTTP GET</strong>El navegador pide la página, viewer.js y la info de cada imagen</div>
        <div className="flow-arrow">→</div>
        <div className="flow-step"><strong>Upgrade 101</strong>El cliente pide /ws con subprotocolo ultratile.utp.v1</div>
        <div className="flow-arrow">→</div>
        <div className="flow-step"><strong>UTP por WS</strong>Chunks más commit. Tiles más end. Abort al mover la vista</div>
      </div>
      <div className="cards d3">
        <div className="card">
          <h3>Por que TCP y no UDP</h3>
          <p>Los tiles exigen orden y entrega total. Un tile corrupto o perdido rompe el mosaico. TCP da orden, retransmision y control de flujo. UDP obligaria a reescribir ese control en el protocolo. El costo no se justifica en una red local de demo.</p>
        </div>
        <div className="card">
          <h3>Una sesion estable</h3>
          <p>La página abre un solo socket. Cambiar de imagen reusa el socket y mantiene la serie de reqId. La URL del socket deriva del host de la página. Asi pasa la regla de origen contra host.</p>
        </div>
      </div>
    </div>
  ),

  // 6. Control de transmisión
  () => (
    <div className="slide-content">
      <h2>Gestión y control de la transmisión</h2>
      <p className="subtitle d1">Cada sesion corre con dos hilos virtuales. Un lector valida. Un despachador envia. Un candado ordena los bytes.</p>
      <div className="d2">
        <div className="kv"><span className="kv-num">1</span><span>El lector acepta chunks, avanza lastReqIdSeen solo ante una generacion nueva valida y sella la lista work al llegar el commit.</span></div>
        <div className="kv"><span className="kv-num">2</span><span>El commit publica un solo slot combinado. Un commit nuevo reemplaza al anterior sin despachar. Asi nunca se acumulan permisos.</span></div>
        <div className="kv"><span className="kv-num">3</span><span>El despachador ordena los tiles del centro hacia afuera por distancia Manhattan y respeta el presupuesto de red.</span></div>
        <div className="kv"><span className="kv-num">4</span><span>La admision final ocurre dentro del candado de escritura. Ningun tile empieza despues de un frame de cierre.</span></div>
        <div className="kv"><span className="kv-num">5</span><span>El mensaje end sale solo si la generacion sigue activa, drenada y sin envios en vuelo. Si se cancelo, no hay end.</span></div>
      </div>
      <p className="foot d3">Regla stale contra invalido. Un paquete viejo se ignora y la conexion sigue. Un paquete ilegal contra la generacion activa cierra con código 1002 tras enviar el frame de cierre. Un chunk nuevo invalido se registra y su commit cierra.</p>
    </div>
  ),

  // 7. Viewer
  () => (
    <div className="slide-content">
      <h2>El viewer y la carga selectiva</h2>
      <p className="subtitle d1">Cada intencion de vista abre una época. La época vieja se limpia por completo. La red y la pantalla se miden por separado.</p>
      <div className="cards d2">
        <div className="card">
          <h3>Como pide el viewer</h3>
          <p>Resta de lo necesario lo que ya tiene en cache, en red, en cola de decodificacion, en terminal y en omitidos del servidor. Agrupa por filas del mismo zoom. Envia lotes segun memoria libre. Espera el end y resuelve. Nunca espera a pintar el 100 por ciento.</p>
        </div>
        <div className="card">
          <h3>Dos coberturas distintas</h3>
          <p>netCov cuenta tiles recibidos más omitidos por el servidor. covCov cuenta pixeles visibles en cache. El flujo avanza con netCov y el drenaje de decodificacion. covCov solo informa en el HUD.</p>
        </div>
      </div>
      <div className="chart-wrap d3">
        <MemoryEnvelopeChart />
        <p className="foot">Techo de memoria del diseño. Cache de 40 tiles equivale a 40 MiB en pixeles. Más 12 MiB en vuelo y 4 MiB en cola. El pico transitorio adverso llega a 60 MiB y se declara aparte.</p>
      </div>
    </div>
  ),

  // 8. Problemas
  () => (
    <div className="slide-content">
      <h2>Problemas que encontramos y como los resolvimos</h2>
      <p className="subtitle d1">Cada fila es un fallo real del diseño con su causa y su arreglo verificado por prueba.</p>
      <table className="compare d2">
        <thead><tr><th>Problema</th><th>Causa</th><th>Solucion</th></tr></thead>
        <tbody>
          <tr><td>ImageIO agotaba memoria</td><td>El metodo read decodifica el raster completo antes de validar</td><td>Se leen ancho y alto primero y se rechaza antes de decodificar si supera 8192 px o 16.7 M pixeles</td></tr>
          <tr><td>Bordes recortados por vips</td><td>dzsave emite bordes recortados y rompia la regla de 512 exactos</td><td>Paso de post pad que rellena de negro a 512 exactos antes de validar</td></tr>
          <tr><td>Permisos acumulados</td><td>Cada commit liberaba un permiso y el despacho enviaba generaciones viejas</td><td>Slot combinado con publicacion por getAndSet. Solo el commit más nuevo despacha</td></tr>
          <tr><td>Cliente colgado sin end</td><td>Un commit invalido se ignoraba y el viewer esperaba para siempre</td><td>El commit nuevo invalido cierra de inmediato. El chunk nuevo invalido se registra y su commit cierra</td></tr>
          <tr><td>Tile tras el cierre</td><td>El filtro previo no veia un cierre que llegaba antes del candado</td><td>Admision dentro del candado en transferTileIf y writeEndIf. Resultado posible apagado sin bytes</td></tr>
          <tr><td>Navegador no puede enviar 1002</td><td>El API de WebSocket en script rechaza ese código</td><td>El viewer cierra con 4002 y el servidor lo acepta y lo refleja como código privado</td></tr>
        </tbody>
      </table>
    </div>
  ),

  // 9. Decisiones
  () => (
    <div className="slide-content">
      <h2>Decisiones fundamentadas para la defensa</h2>
      <p className="subtitle d1">Cada decisión responde a un requisito del proyecto y cita su respaldo.</p>
      <table className="compare d2">
        <thead><tr><th>Decisión</th><th>Por que</th><th>Respaldo</th></tr></thead>
        <tbody>
          <tr><td>Servidor propio en Java sin frameworks</td><td>El curso pide implementar el control y el protocolo a mano</td><td>SocketChannel con virtual threads. Sin Jetty ni Netty</td></tr>
          <tr><td>HTTP estricto más UTP sobre WebSocket</td><td>HTTP inicia. UTP controla resolucion por cliente</td><td>RFC 9110 y RFC 9112 para HTTP. RFC 6455 para el upgrade y los frames</td></tr>
          <tr><td>Tiles de 512 en JPEG Q85</td><td>512 equilibra indice y envios. JPEG Q85 comprime foto real a 45 a 95 KiB</td><td>Piramide con techo. 21 tiles en 2048 y 85 tiles en 4096</td></tr>
          <tr><td>Virtual threads en vez de selector</td><td>El código bloqueante queda simple y cada sesion aisla su estado</td><td>JEP 444. Se declara como modelo de hilos y se pregunta al docente si exige canal asíncrono</td></tr>
          <tr><td>Todo local y sin CDN</td><td>La calificacion corre sin internet</td><td>Activos bajo resources web. Cero referencias externas</td></tr>
        </tbody>
      </table>
      <p className="foot d3">Cobertura de los ocho puntos del enunciado. Multiples clientes por hilos virtuales. Protocolo propio UTP/1.0 documentado. Frontend local servido por Java. Cero peticiones externas. Alta de imagenes por import. Alta calidad solo en servidor. Limpieza de cache en cliente.</p>
    </div>
  ),

  // 10. Cierre
  () => (
    <div className="slide-content">
      <h2>Cierre y plan de demo</h2>
      <p className="subtitle d1">La demo prueba transferencia parcial y limpieza real. Los números del HUD lo confirman.</p>
      <div className="cards d2">
        <div className="card">
          <h3>Pasos de la demo</h3>
          <p>1. Levantar el jar y abrir la página local. Elegir la demo 1 de 4096.</p>
          <p>2. Mover y acercar. El HUD sube rxBytes y reqs.</p>
          <p>3. Barrer en serpentina. El contador evicts supera cero.</p>
          <p>4. Cambiar de zoom 3 a 1. El zoom efectivo cambia y los bitmaps viejos se cierran.</p>
        </div>
        <div className="card">
          <h3>Lo que muestran los contadores</h3>
          <p>rxBytes suma solo payload JPEG. decodedBytes suma lo decodificado. netCov mide red completa. covCov mide pantalla. desired contra effective revela el ajuste de LOD.</p>
        </div>
      </div>
      <p className="foot d3">Documento normativo UTP-1.0 como unica fuente de verdad. Memoria honesta con dos libros. Retenida más transitoria. Alcance declarado de red local con bind en loopback por defecto.</p>
    </div>
  ),
]

function Nav({ cur, total, go, setCur }) {
  return (
    <nav>
      <button onClick={() => go(-1)} disabled={cur === 0}>←</button>
      <div className="dots">
        {Array.from({ length: total }, (_, i) => (
          <div key={i} className={`dot${i === cur ? ' on' : ''}`} onClick={() => setCur(i)} />
        ))}
      </div>
      <button onClick={() => go(1)} disabled={cur === total - 1}>→</button>
      <span className="slide-number">{cur + 1} / {total}</span>
    </nav>
  )
}

function App() {
  const [cur, setCur] = useState(0)
  const go = useCallback((d) => setCur((c) => Math.max(0, Math.min(SLIDES.length - 1, c + d))), [])

  useEffect(() => {
    const h = (e) => {
      if (e.target.tagName === 'INPUT') return
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(1) }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [go])

  return (
    <>
      {cur > 0 && <div className="glyph-watermark"><SentryGlyph size={40} /><span className="watermark-title">UltraTile</span></div>}
      <div className="progress" style={{ width: `${((cur + 1) / SLIDES.length) * 100}%` }} />
      {SLIDES.map((S, i) => (
        <div key={i} className={`slide ${i === cur ? 'active' : ''}`}>
          <div className={`slide-content${i === cur ? ' anim' : ''}`}>
            <S />
          </div>
        </div>
      ))}
      <Nav cur={cur} total={SLIDES.length} go={go} setCur={setCur} />
    </>
  )
}

export default App
