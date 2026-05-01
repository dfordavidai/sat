import { NextResponse } from 'next/server'

export async function middleware(request) {
  const host = request.headers.get('host') || ''

  // Match any subdomain of flexygist.com.ng
  if (host.endsWith('.flexygist.com.ng')) {
    return NextResponse.redirect(
      'https://latestupdates.infinityfreeapp.com/pages/sisialagbo/',
      { status: 301 }
    )
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next|favicon.ico).*)']
}
