# Proyecto

# Proyecto Servidor Asíncrono

El presente proyecto tiene como objetivo que el alumno profundice en el funcionamiento del protocolo HTTP y en el diseño e implementación de mecanismos de comunicación sobre protocolos establecidos de la capa de aplicación del modelo OSI.

El proyecto consiste en desarrollar un servidor asíncrono en Java capaz de gestionar y proporcionar imágenes de ultra alta resolución a múltiples clientes, evitando la transferencia innecesaria de grandes cantidades de información y reduciendo el consumo de recursos tanto en el servidor como en el navegador del usuario.

El problema se inspira en imágenes de dimensiones extremadamente grandes, como aquellas utilizadas en plataformas de visualización panorámica o geográfica, donde una imagen puede alcanzar cientos de gigapíxeles y ocupar cientos de gigabytes de almacenamiento.

La dificultad principal consiste en permitir que el usuario pueda visualizar y explorar este tipo de imágenes sin que sea necesario transferir la imagen completa al cliente.

El alumno deberá diseñar una solución propia que permita realizar una carga progresiva y selectiva de la información de la imagen, determinando qué información debe ser enviada al cliente en función de las necesidades actuales de visualización.

La solución deberá considerar aspectos de rendimiento, transferencia de datos, concurrencia, utilización de memoria y gestión de recursos.

## Descripción

En este proyecto, vamos a realizar lo siguiente: servir imágenes de ultra calidad utilizando una técnica innovadora. La meta es simular la carga progresiva de las famosas imágenes de 400 Gigapíxeles y más de 700 Gigabytes que existen en GigaPan o EarthCam. Sin embargo, debe recordar que se tiene que abordar este desafío con inteligencia y eficiencia para evitar sobrecargar el ancho de banda y el navegador de los usuarios que consulten tales imágenes.

Para lograrlo, implementaremos un proceso de carga selectiva. Esto significa que, en lugar de cargar la imagen completa de una sola vez, iremos mostrando gradualmente diferentes secciones de la imagen a medida que el usuario la visualiza. De esta manera, optimizaremos el rendimiento y proporcionaremos una experiencia de navegación fluida y rápida.

Las imágenes de ultra alta resolución pueden alcanzar dimensiones y tamaños de almacenamiento que hacen inviable su transferencia completa hacia un navegador web.

Por ejemplo, una imagen extremadamente grande podría requerir cientos de gigabytes de almacenamiento. Descargarla completamente hacia el cliente provocaría:

- Un consumo excesivo de ancho de banda.
- Tiempos de espera elevados.
- Un consumo excesivo de memoria y recursos del navegador.
- Una posible degradación del rendimiento del equipo del usuario.
- Transferencia de información que posiblemente nunca será visualizada por el usuario.
- El proyecto busca resolver este problema mediante el diseño de un mecanismo que permita transferir únicamente la información necesaria para la visualización actual de la imagen, manteniendo una experiencia de navegación adecuada.

El alumno deberá determinar cómo almacenar, procesar, dividir, transformar, seleccionar y transferir la información de la imagen.

La estrategia concreta para resolver este problema no será proporcionada por el proyecto y deberá ser propuesta, implementada y justificada por cada alumno.

> **Se debe de aclarar que esta funcionalidad NO ES UN ZOOM IN DE DESPLAZAMIENTO en tiempo real (tipo Amazon o TEMU), en la solución del proyecto existe transferencia y eliminación de información para aumentar o disminuir la resolución.**

## Puntos importantes de la implementación

1. El servidor Java debe ser capaz de poder atender múltiples clientes.

2. El servidor debe de tener su propio protocolo de comunicación para llevar el control de la resolución de imágenes para cada cliente.

3. La interfaz gráfica puede ser realizada en HTML, JS y CSS o en algún framework de su preferencia.

4. La interfaz gráfica puede utilizar librerías conocidas para utilizar en el frontend y que tienen que estar alojadas en el servidor Java.

5. Todo objeto solicitado tiene que ser manejado por el servidor Java, no puede haber solicitudes externas a otros servidores.

6. Al servidor se le pueden agregar nuevas imágenes de ultra calidad para que sean tratadas y puedan ser servidas a los clientes que la soliciten.

7. Las imágenes no pueden ser servidas completamente en ultra calidad al cliente, estas tienen que ser manejadas del lado del servidor, no del cliente.

8. Del lado del cliente debe gestionar los archivos cargados para no sobrecargar el navegador del usuario.

La comunicación inicial debe utilizar el protocolo HTTP ya conocido para el envío de archivos iniciales, la forma de transmisión de la imagen debe generar su propio protocolo de control y documentarlo.

### Esquema de comunicación

```text
                 HTTP Request
Server  ------------------------------>  Client

                 HTTP Response
Server  ------------------------------>  Client

                 Protocol Image
Server  <------------------------------  Client
````

## Entrega

* El Proyecto se realizará de forma individual.
* El lenguaje del Server será en Java versión 20 o 21.
* El manejo del DOM del lado del cliente queda a discreción del alumno.
* El Documento debe ser coherente, conciso y acorde a su proyecto, dando referencias a RFC o procesos encontrados citables, que haya implementado para desarrollar su propuesta.
* El proyecto **NO es un ZOOM IN de imágenes desatendido**.
* El Proyecto debe ser entregado por medio del GES y calificado de forma Virtual o Presencial, solo la entrega por el GES no es válida.
* Si no sigue lineamientos, no compila o si se detecta plagio se calificará con cero.
* El proyecto se calificará desconectado de internet.
* Se tendrá la siguiente distribución de puntaje:

| Componente                            | Puntaje |
| ------------------------------------- | ------: |
| Server Backend (Manejador de Request) |     35% |
| FrontEnd (Sitio Web)                  |     30% |
| Documento Protocolo de Imagen         |     35% |

## Referencias de Imágenes Grandes por Torrent

* **2+ GB:** [https://commons.wikimedia.org/wiki/Commons%3AVery_high-resolution_file_downloads](https://commons.wikimedia.org/wiki/Commons%3AVery_high-resolution_file_downloads)
* **24.6 GB:** [https://www.eso.org/public/images/eso1242a/](https://www.eso.org/public/images/eso1242a/)