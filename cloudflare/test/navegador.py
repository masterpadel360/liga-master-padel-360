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
    foto(page, '06-exito')

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
    page.click('.more-item[data-go="admin-reservas"]')
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

    page.click('[data-org-filtro="proximas"]')
    page.wait_for_selector('.org-res [data-org="pago"]')
    page.locator('.org-res', has_text='Jugadora Prueba').locator('[data-org="pago"]').click()
    page.wait_for_selector('.org-toast')
    page.wait_for_selector('.org-res:has-text("Jugadora Prueba") [data-completo="0"]')
    ok('marcó saldo pagado')

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
    page.fill('#bMotivo', 'Clase de prueba')
    page.click('[data-org="crear-bloqueo"]')
    page.wait_for_selector('.org-ag-linea:has-text("Clase de prueba")')
    ok('bloqueó un horario')
    foto(page, '14-org-horarios')

    page.click('[data-org-tab="contenido"]')
    page.wait_for_selector('[data-bloque-tipo="NOVEDAD"]')
    page.set_input_files('#fotoFiles', comp)
    page.wait_for_selector('.org-foto img', timeout=15000)
    ok('subió una foto a la galería')
    foto(page, '15-org-contenido')

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
