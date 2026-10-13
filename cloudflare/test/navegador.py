"""Recorre la app real en un Chromium (tamaño celular) contra el servidor local.
Uso: python3 cloudflare/test/navegador.py <carpeta_capturas>
"""
import sys, os, base64, time
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(OUT, exist_ok=True)
BASE = 'http://localhost:8787/'
errores = []
pasos = []

def ok(msg):
    pasos.append('OK  ' + msg)
    print('OK  ' + msg, flush=True)

def foto(page, nombre):
    page.screenshot(path=os.path.join(OUT, nombre + '.png'), full_page=False)

# imagen de comprobante de prueba (PNG grande para probar la compresión)
from PIL import Image
img = Image.new('RGB', (3000, 4000), (240, 240, 240))
comp = os.path.join(OUT, 'comprobante.png')
img.save(comp)

with sync_playwright() as p:
    nav = p.chromium.launch()
    ctx = nav.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.on('console', lambda m: errores.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errores.append('PAGEERROR ' + str(e)))
    peticiones = []
    page.on('request', lambda r: peticiones.append(r.url))

    t0 = time.time()
    page.goto(BASE)
    page.fill('#accesoClave', 'padel360')
    page.click('#accesoBtn')
    page.wait_for_selector('#app:not([hidden])')
    page.wait_for_selector('#cat-select-cta:not([hidden]), #cat-active-row:not([hidden])')
    ok('entra con la contraseña de la liga (%.1fs)' % (time.time() - t0))
    assert not any('script.google.com' in u for u in peticiones), 'todavía llama a Apps Script'
    ok('ya no llama a Google Apps Script')
    foto(page, '01-inicio')
    estado = page.text_content('#hero-status')
    assert estado.strip() == 'FECHA 4 EN JUEGO', estado
    ok('portada muestra la fecha en juego del panel: ' + estado.strip())

    page.click('#cat-select-cta')
    page.click('#inicioCats [data-cat="6ta Masculino"]')
    page.click('.nav-item[data-nav="posiciones"]')
    page.wait_for_selector('#posRows .standing-row')
    n = page.locator('#posRows .standing-row').count()
    assert n == 6, n
    ok('posiciones: %d parejas' % n)
    foto(page, '02-posiciones')
    page.click('.nav-item[data-nav="fixture"]')
    page.wait_for_selector('#fixMatches .match-card')
    ok('fixture con %d partidos en la fecha' % page.locator('#fixMatches .match-card').count())
    page.click('.nav-item[data-nav="resultados"]')
    page.wait_for_selector('#resMatches .match-card')
    ok('resultados: %d partidos' % page.locator('#resMatches .match-card').count())
    foto(page, '03-resultados')

    # ---------------- reserva completa
    page.click('.nav-item[data-nav="mas"]')
    page.click('.more-item[data-go="reservar"]')
    page.wait_for_selector('#rsvCats [data-rsv-cat]')
    page.click('#rsvCats [data-rsv-cat="8va Femenino"]')
    page.wait_for_selector('#rsvCruces [data-rsv-partido], #rsvDias [data-rsv-fecha]')
    if page.locator('#rsvCruces [data-rsv-partido]').count() and page.locator('#rsv-panel-cruce:not([hidden])').count():
        page.locator('#rsvCruces [data-rsv-partido]').first.click()
    page.wait_for_selector('#rsvDias [data-rsv-fecha]')
    foto(page, '04-turnos')
    page.locator('#rsvDias [data-rsv-fecha]').first.click()
    if page.locator('#rsv-panel-cruce:not([hidden])').count():
        page.wait_for_selector('#rsvCruces [data-rsv-partido]')
        page.locator('#rsvCruces [data-rsv-partido]').first.click()
    page.wait_for_selector('#rsv-panel-checkout:not([hidden])')
    ok('retuvo el turno y pasó al pago')
    page.fill('#rsvNombre', 'Jugadora Prueba')
    page.fill('#rsvTelefono', '351 444-5566')
    page.set_input_files('#rsvComprobante', comp)
    page.wait_for_function("document.getElementById('rsvUploadTx').textContent.indexOf('Seleccionado') === 0")
    tam = page.evaluate("reservaComprobante_.base64.length * 0.75")
    ok('comprobante de %d KB comprimido a %d KB en el celular' % (os.path.getsize(comp) // 1024, tam // 1024))
    foto(page, '05-checkout')
    t0 = time.time()
    page.click('#rsvConfirmarBtn')
    page.wait_for_selector('#rsv-panel-exito:not([hidden])', timeout=15000)
    codigo = page.text_content('#rsv-exito-codigo')
    ok('reserva confirmada en %.1fs, código %s' % (time.time() - t0, codigo))
    assert page.is_visible('#rsvWaAlerta') and 'ATENCIÓN' in page.text_content('#rsvWaTitulo')
    ok('cartel "ATENCIÓN: mandá tu reserva por WhatsApp" visible')
    foto(page, '06-exito')
    preguntas = []
    page.once('dialog', lambda d: (preguntas.append(d.message), d.dismiss()))
    page.click('#rsvVolverAReservar')
    assert preguntas and 'WhatsApp' in preguntas[0], preguntas
    assert page.is_visible('#rsv-panel-exito')
    ok('si quiere salir sin mandar el WhatsApp, se lo recuerda')
    with ctx.expect_page() as nueva:
        page.click('#rsvWhatsappLink')
    nueva.value.close()
    assert 'Gracias' in page.text_content('#rsvWaTitulo')
    ok('al tocar WhatsApp el cartel cambia a "¡Gracias!"')

    # buscar mi reserva
    page.goto(BASE)
    page.wait_for_selector('#app:not([hidden])')
    page.click('.nav-item[data-nav="mas"]')
    page.click('.more-item[data-go="buscar-reserva"]')
    page.fill('#buscarTelefono', '3514445566')
    page.fill('#buscarCodigo', codigo)
    page.click('#buscarReservaBtn')
    page.wait_for_selector('#rsvGestionContenido .rsv-summary')
    assert 'Pendiente de aprobación' in page.text_content('#rsvGestionContenido')
    ok('"Buscar mi reserva" la encuentra pendiente')

    # ---------------- panel de organizador
    page.click('.nav-item[data-nav="mas"]')
    assert page.locator('.more-item-org').is_hidden(), 'el jugador ve el panel'
    ok('el jugador NO ve "Panel de organizador" en Más')
    page.goto(BASE + '?admin=1')
    page.wait_for_selector('#orgClave')
    foto(page, '07-org-login')
    page.fill('#orgClave', 'mala')
    page.click('#orgEntrar')
    page.wait_for_selector('#orgLoginErr:not([hidden])')
    ok('clave incorrecta rechazada')
    page.fill('#orgClave', 'clave-orga')
    page.click('#orgEntrar')
    page.wait_for_selector('.org-stats')
    ok('entra al panel: ' + page.text_content('.org-stat b') + ' reservas para aprobar')
    foto(page, '08-org-inicio')

    page.click('[data-org-tab="reservas"]')
    page.wait_for_selector('.org-res')
    foto(page, '09-org-reservas')
    tarjeta = page.locator('.org-res', has_text='Jugadora Prueba')
    tarjeta.locator('[data-org="aprobar"]').click()
    page.wait_for_selector('.org-res.is-hecha .org-wa')
    href = tarjeta.locator('.org-wa').get_attribute('href')
    assert href.startswith('https://wa.me/5493514445566?text='), href
    ok('aprobó y ofrece avisar por WhatsApp al 549 351 444 5566')
    foto(page, '10-org-aprobada')

    assert 'Nos vemos' not in href
    page.click('[data-org-filtro="proximas"]')
    page.wait_for_selector('.org-res:has-text("Jugadora Prueba") .org-pago')
    tarjeta = page.locator('.org-res', has_text='Jugadora Prueba')
    n = tarjeta.locator('[data-org="pago-jug"]').count()
    if tarjeta.locator('[data-org="pago-sena"]').count():
        tarjeta.locator('[data-org="pago-sena"]').first.click()
        page.wait_for_selector('.org-res:has-text("Jugadora Prueba") .org-pill-sena')
    for _ in range(3):
        page.locator('.org-res', has_text='Jugadora Prueba').locator('[data-org="pago-jug"][data-pagado="1"]').first.click()
        page.wait_for_timeout(400)
    page.wait_for_selector('.org-res:has-text("Jugadora Prueba") .org-bloque-tit:has-text("completo")')
    ok('tildó los pagos de los 4 jugadores (seña + 3)')
    foto(page, '10b-org-pagos')
    for tab in ['porcerrar', 'completas', 'rechazadas', 'historial']:
        page.click('[data-org-filtro="%s"]' % tab)
        page.wait_for_selector('#orgListaRes .org-res, #orgListaRes .state-empty')
    ok('pestañas Por cerrar / Completas / Rechazadas / Historial')

    # buscador de reservas: en vivo, sin tildes ni mayúsculas, en todas las pestañas
    page.click('[data-org-filtro="pendientes"]')
    page.wait_for_selector('#orgBuscar')
    page.locator('#orgBuscar').press_sequentially('jugadora prúeba', delay=30)
    page.wait_for_selector('#orgListaRes .org-res:has-text("Jugadora Prueba")')
    assert page.locator('.org-subtabs').is_hidden()
    assert page.evaluate("document.activeElement.id") == 'orgBuscar'
    ok('buscador encuentra "Jugadora Prueba" escribiendo "jugadora prúeba" desde Para aprobar')
    foto(page, '10c-org-buscador')
    page.fill('#orgBuscar', '4445566')
    page.dispatch_event('#orgBuscar', 'input')
    page.wait_for_selector('#orgListaRes .org-res:has-text("Jugadora Prueba")')
    ok('buscador encuentra por teléfono')
    page.fill('#orgBuscar', 'zzzz nadie')
    page.dispatch_event('#orgBuscar', 'input')
    page.wait_for_selector('#orgListaRes .state-empty')
    page.click('[data-org="limpiar-busqueda"]')
    page.wait_for_selector('.org-subtabs:not([hidden])')
    assert page.input_value('#orgBuscar') == ''
    ok('sin resultados muestra aviso y la ✕ vuelve a las pestañas')

    page.click('[data-org-tab="agenda"]')
    page.wait_for_selector('.org-dia')
    ok('agenda con %d turnos ocupados esta semana' % page.locator('.org-ag-linea:not(.is-bloqueo)').count())
    foto(page, '11-org-agenda')

    page.click('[data-org-tab="resultados"]')
    page.wait_for_selector('details.org-fecha[open] .org-partido')
    page.click('[data-org-catres="8va Masculino"]')
    page.wait_for_selector('details.org-fecha[open] .org-partido')
    fila = page.locator('details.org-fecha[open] .org-partido').first
    fila.locator('[data-set="1"]').fill('6-3')
    fila.locator('[data-set="2"]').fill('6-4')
    fila.locator('[data-org="guardar-resultado"]').click()
    page.wait_for_selector('details.org-fecha[open] .org-partido .is-ganador')
    ok('cargó un resultado y marcó al ganador')
    foto(page, '12-org-resultados')

    page.click('[data-org-tab="parejas"]')
    page.wait_for_selector('#orgFormPareja')
    page.fill('#pj1', 'Nueva')
    page.fill('#pj2', 'Pareja')
    page.click('[data-org="guardar-pareja"]')
    page.wait_for_selector('.org-pareja:has-text("Nueva / Pareja")')
    ok('agregó una pareja')
    foto(page, '13-org-parejas')

    page.click('[data-org-tab="horarios"]')
    page.wait_for_selector('#orgGrilla')
    page.click('[data-org="nuevo-bloqueo"]')
    page.fill('.org-form-bloqueo [data-b="motivo"]', 'Clase de prueba')
    page.click('[data-org="guardar-bloqueo"]')
    page.wait_for_selector('#orgListaBloqueos .org-ag-linea:has-text("Clase de prueba")')
    ok('bloqueó un horario')
    page.locator('#orgListaBloqueos .org-ag-linea', has_text='Clase de prueba').locator('[data-org="editar-bloqueo"]').click()
    page.fill('.org-form-bloqueo [data-b="horaInicio"]', '20:00')
    page.fill('.org-form-bloqueo [data-b="horaFin"]', '21:00')
    page.click('.org-form-bloqueo [data-org="guardar-bloqueo"]')
    page.wait_for_selector('#orgListaBloqueos .org-ag-linea:has-text("20:00–21:00")')
    ok('movió el bloqueo a otro horario')
    page.click('[data-org="calcular-turnos"]')
    page.wait_for_selector('[data-te]')
    nt = page.locator('[data-te]').count()
    page.click('[data-org="crear-turnos"]')
    page.wait_for_selector('#orgEspeciales .org-ag-linea')
    ok('turnos especiales del sábado: %d calculados y agregados' % nt)
    page.click('[data-org="nueva-clase"]')
    page.select_option('#kDia', '3')
    page.fill('#kIni', '21:00'); page.fill('#kFin', '22:00'); page.fill('#kProfe', 'Recupero')
    page.click('[data-org="guardar-clase"]')
    page.wait_for_selector('[data-clase]:has-text("Recupero")')
    ok('agregó una clase fija')
    foto(page, '14-org-horarios')

    page.click('[data-org-tab="contenido"]')
    page.wait_for_selector('[data-bloque-tipo="NOVEDAD"]')
    page.set_input_files('#fotoFiles', comp)
    page.wait_for_selector('.org-foto img', timeout=15000)
    ok('subió una foto a la galería')
    foto(page, '15-org-contenido')

    page.goto(BASE)
    page.wait_for_selector('#app:not([hidden])')
    page.click('.nav-item[data-nav="mas"]')
    assert page.locator('.more-item-org').is_visible()
    ok('en el dispositivo del organizador sí aparece en Más')

    # entrada directa con la clave de organizador desde la pantalla inicial
    ctx2 = nav.new_context(viewport={'width': 390, 'height': 844})
    p2 = ctx2.new_page()
    p2.goto(BASE)
    p2.fill('#accesoClave', 'clave-orga')
    p2.click('#accesoBtn')
    p2.wait_for_selector('.org-stats')
    ok('clave de organizador en la entrada abre directo el panel')
    p2.goto(BASE)
    p2.wait_for_selector('#app:not([hidden])')
    ok('y queda adentro de la app sin pedir la clave de jugador')
    ctx3 = nav.new_context(viewport={'width': 390, 'height': 844})
    p3 = ctx3.new_page()
    p3.goto(BASE)
    p3.fill('#accesoClave', 'cualquiera')
    p3.click('#accesoBtn')
    p3.wait_for_selector('#access-error:not([hidden])')
    assert 'incorrecta' in p3.text_content('#access-error')
    ok('clave equivocada: "Contraseña incorrecta"')

    # vista de escritorio
    page.set_viewport_size({'width': 1280, 'height': 860})
    page.goto(BASE + '?admin=1')
    page.wait_for_selector('.org-stats')
    foto(page, '16-org-escritorio')
    page.click('[data-org-tab="reservas"]')
    page.wait_for_selector('#orgListaRes .org-res, #orgListaRes .state-empty')
    ok('panel en pantalla de compu (entrando con ?admin=1)')
    foto(page, '17-org-escritorio-reservas')

    nav.close()

print('\n'.join(['', 'Errores de consola: %d' % len(errores)] + errores[:20]))
sys.exit(1 if errores else 0)
