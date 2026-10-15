from flask import Blueprint

sosreport = Blueprint('sosreport', __name__, url_prefix='/sosreport')

# Add sosreport-specific routes here if needed
# Example:
# @sosreport.route('/status')
# def status():
#     return jsonify({'status': 'ok', 'type': 'sosreport'})
